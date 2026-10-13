import { createHash, randomUUID } from "node:crypto";
import type { ContextReference } from "../../domain/context/context.js";
import { validateContextManifest } from "../../domain/context/context-validator.js";
import type { AgentRuntimeDeps } from "../../domain/ports/runtime-ports.js";
import type { SessionStorePort } from "../../domain/ports/session-store-port.js";
import type { RuntimeEvent } from "../../domain/process/process-events.js";
import {
  profileIdentity,
  selectProfileClient,
} from "../../domain/profiles/profile.js";
import { executionPolicy } from "../../domain/profiles/profile-policy.js";
import type { HeadlessProvider } from "../../domain/providers/provider.js";
import { redactRuntimeText } from "../../domain/redaction/redaction.js";
import {
  buildExecutionPlan,
  type ExecutionPlan,
  executionPlanIdentity,
} from "../../domain/runs/execution-plan.js";
import type { RunContract } from "../../domain/runs/run-contract.js";
import { validateSessionEntryContract } from "../../domain/sessions/entry-contract.js";
import type { Session } from "../../domain/sessions/session.js";
import type { SkillIndexEntry } from "../../domain/skills/skill.js";
import {
  buildContextReferences,
  referenceReadDirectories,
} from "../context/context-references.js";
import { getHandoff } from "../handoff/handoff-service.js";
import { emitHook } from "../hooks/lifecycle-hooks.js";
import {
  buildProfileFactsDigest,
  profileFactsFile,
  readProfileFacts,
} from "../memory/profile-facts.js";
import { finalizeSession } from "../memory/session-closeout.js";
import { loadPromotedSkills } from "../skills/skill-curation.js";
import {
  assemblePrompt,
  formatProfileContract,
  formatPromotedSkills,
  formatSkillIndex,
  PROMOTED_SKILL_MAX_BYTES,
  readDirectoriesOutside,
} from "./prompt-assembly.js";
import { authorizeRun } from "./run-authorization.js";

// Re-exported for existing importers (scheduler, task-loop, gateway).
export type { AgentRuntimeDeps } from "../../domain/ports/runtime-ports.js";

export type AgentRunRequest = {
  profileName: string;
  prompt: string;
  cwd: string;
  parentSessionId?: string;
  sessionId?: string;
  runContract?: RunContract;
  client?: string;
  actor?: string;
  title?: string;
  taskId?: string;
  handoffId?: string;
};

export async function runAgent(
  request: AgentRunRequest,
  deps: AgentRuntimeDeps,
): Promise<Session> {
  const execute = deps.executeProvider;
  const profile = selectProfileClient(
    await deps.loadProfile(request.profileName),
    request.client,
  );
  const handoff = request.handoffId
    ? await getHandoff(request.handoffId, deps.openStore)
    : null;
  const effectiveTaskId =
    request.taskId ??
    (typeof handoff?.taskId === "string" ? handoff.taskId : null);
  const clientHome = deps.resolveClientHome(profile);
  executionPolicy(profile, request.cwd);
  deps.assertProviderSupportsReadOnly(profile.provider as HeadlessProvider);
  if (
    profile.writePolicy !== "none" &&
    !request.runContract?.approval.approved
  ) {
    throw new Error("Writable profile runs require an approved run contract");
  }
  if (profile.governance?.approvalRequired && !request.runContract) {
    throw new Error("Profile requires an approved run contract");
  }
  const plan = buildExecutionPlan(profile, {
    cwd: request.cwd,
    supportedTransports: runtimeTransports,
    writeAllowed: false,
  });
  const sessionStore = await deps.openStore();
  const sessionId = request.sessionId ?? randomUUID();
  const session = sessionStore.create({
    sessionId,
    title:
      request.title ??
      (typeof handoff?.title === "string"
        ? handoff.title
        : request.prompt.slice(0, 120)),
    taskId: effectiveTaskId,
    handoffId: request.handoffId ?? null,
    provider: profile.provider,
    providerSessionId: null,
    parentSessionId: request.parentSessionId ?? null,
    profile: profile.name,
    profileIdentity: profileIdentity(profile),
    workingDirectory: request.cwd,
    resumeData: null,
  });

  if (request.runContract) {
    if (request.runContract.sessionId !== sessionId) {
      sessionStore.close();
      throw new Error(
        "Run contract session does not match the session being created",
      );
    }
    try {
      authorizeRun(sessionStore, request.runContract);
    } catch (error) {
      sessionStore.close();
      throw error;
    }
  }

  try {
    sessionStore.appendEvent(
      sessionId,
      "session_entry_contract",
      JSON.stringify(
        validateSessionEntryContract({
          entryPoint: "ocean-run",
          controlLevel: "full-head",
          inputCapture: "semantic",
          contextTransport: "profile-context-and-provider-adapter",
          policyEnforcement: "profile-and-run-contract",
          promotion: "explicit-review",
          resume:
            profile.provider === "claude"
              ? "provider-session-id"
              : "unsupported",
        }),
      ),
    );
    appendExecutionPlan(sessionStore, sessionId, plan);
    const context = await buildContextReferences({
      profile,
      prompt: request.prompt,
      cwd: request.cwd,
    });
    const factsDigest = plan.memoryNamespace
      ? buildProfileFactsDigest(
          plan.memoryNamespace,
          await readProfileFacts(plan.memoryNamespace),
        )
      : { text: "", partial: false };
    const skillIndex = await deps.loadSkillIndex(profile.skills, request.cwd);
    const autoSkills = await loadPromotedSkills(
      request.prompt,
      PROMOTED_SKILL_MAX_BYTES,
    );
    for (const skill of autoSkills) {
      sessionStore.appendEvent(
        sessionId,
        "skill_auto_activated",
        JSON.stringify({
          id: skill.id,
          name: skill.name,
          sourceSessionId: skill.sourceSessionId ?? null,
        }),
      );
    }
    sessionStore.appendEvent(
      sessionId,
      "user_input",
      redactRuntimeText(request.prompt),
    );
    if (request.actor)
      sessionStore.appendEvent(sessionId, "actor_bound", request.actor);
    sessionStore.appendEvent(
      sessionId,
      "context_manifest",
      JSON.stringify(context.manifest),
    );
    sessionStore.updateStatus(sessionId, "running");
    await emitHook("session.start", {
      sessionId,
      profile: profile.name,
      provider: profile.provider,
    });
    const handoffContent =
      typeof handoff?.compactContext === "string"
        ? `## Ocean handoff\n${handoff.compactContext}`
        : "";
    const { prompt, bytes, breakdown } = assemblePrompt({
      request: request.prompt,
      profile: formatProfileContract(profile, {
        taskId: effectiveTaskId,
        handoffId: request.handoffId ?? null,
      }),
      instructions: profile.instructions,
      skills: [formatSkillIndex(skillIndex), formatPromotedSkills(autoSkills)]
        .filter(Boolean)
        .join("\n\n"),
      facts: factsDigest.text,
      handoff: handoffContent,
      context: context.content,
    });
    const contextHash = createHash("sha256").update(prompt).digest("hex");
    sessionStore.updateContext(sessionId, contextHash, bytes);
    sessionStore.appendEvent(
      sessionId,
      "context_cost",
      JSON.stringify({
        bytes,
        sources: context.manifest.files,
        handoffId: request.handoffId ?? null,
        selectedSkills: [...skillIndex, ...autoSkills].map(
          (skill) => skill.name,
        ),
        sections: breakdown,
      }),
    );
    const result = await execute({
      provider: profile.provider as HeadlessProvider,
      prompt,
      cwd: request.cwd,
      clientHome,
      timeoutMs: request.runContract?.budget.timeoutMs,
      maxOutputBytes: request.runContract?.budget.maxOutputBytes,
      readOnly: plan.readOnly,
      readDirectories: headlessReadDirectories({
        cwd: request.cwd,
        profileName: profile.name,
        skillIndex,
        factsPartial: factsDigest.partial,
        contextDirectories: context.readDirectories,
      }),
      onSpawn: (pid) => sessionStore.setProviderPid(sessionId, pid),
      onEvent: (event) => {
        captureProviderSessionId(sessionStore, sessionId, event);
        sessionStore.appendEvent(
          sessionId,
          event.type,
          boundedEventData(event),
        );
      },
    });
    sessionStore.clearProviderPid(sessionId);
    sessionStore.updateStatus(
      sessionId,
      result.exitCode === 0 ? "completed" : "failed",
    );
    sessionStore.appendEvent(
      sessionId,
      "process_exit",
      JSON.stringify({
        exitCode: result.exitCode,
        stderr: redactRuntimeText(result.stderr),
      }),
    );
    sessionStore.appendEvent(
      sessionId,
      "evidence",
      JSON.stringify({
        evidenceId: randomUUID(),
        sessionId,
        type: "provider_exit",
        source: "headless-process",
        observedAt: new Date().toISOString(),
        result: result.exitCode === 0 ? "proven" : "not_proven",
        criterion: "provider process exits successfully",
        payload: JSON.stringify({ exitCode: result.exitCode }),
      }),
    );
    sessionStore.scanCaptureItems(sessionId);
    await deps.appendRuntimeLog({
      timestamp: new Date().toISOString(),
      event: result.exitCode === 124 ? "provider_timeout" : "run_finished",
      correlationId: sessionId,
      sessionId,
      provider: profile.provider,
      status: result.exitCode === 0 ? "completed" : "failed",
      payload: JSON.stringify({ exitCode: result.exitCode }),
    });
    await finalizeSession(sessionStore, sessionId, {
      exitCode: result.exitCode,
    });
    await emitHook("session.end", {
      sessionId,
      status: result.exitCode === 0 ? "completed" : "failed",
      exitCode: result.exitCode,
    });
    return sessionStore.get(sessionId) ?? session;
  } catch (error) {
    sessionStore.clearProviderPid(sessionId);
    sessionStore.updateStatus(sessionId, "failed");
    sessionStore.scanCaptureItems(sessionId);
    sessionStore.appendEvent(
      sessionId,
      "error",
      redactRuntimeText(error instanceof Error ? error.message : String(error)),
    );
    await finalizeSession(sessionStore, sessionId, { exitCode: 1 });
    await emitHook("run.error", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    await deps.appendRuntimeLog({
      timestamp: new Date().toISOString(),
      event: "run_failed",
      correlationId: sessionId,
      sessionId,
      provider: profile.provider,
      status: "failed",
    });
    throw error;
  } finally {
    sessionStore.close();
  }
}

export async function resumeAgent(
  sessionId: string,
  prompt: string,
  deps: AgentRuntimeDeps,
  runContract?: RunContract,
): Promise<Session> {
  const execute = deps.executeProvider;
  const sessionStore = await deps.openStore();
  try {
    const existing = sessionStore.get(sessionId);
    if (!existing) throw new Error(`Session not found: ${sessionId}`);
    if (existing.provider !== "claude" || !existing.providerSessionId) {
      throw new Error(
        `Provider does not support resume yet: ${existing.provider}`,
      );
    }
    const profile = selectProfileClient(
      await deps.loadProfile(existing.profile),
      existing.provider,
    );
    executionPolicy(profile, existing.workingDirectory);
    deps.assertProviderSupportsReadOnly(profile.provider as HeadlessProvider);
    if (profile.writePolicy !== "none")
      throw new Error("Writable profile resumes require an enforcing sandbox");
    if (profileIdentity(profile) !== existing.profileIdentity)
      throw new Error(
        "Profile changed since the session was created; start a new reviewed run",
      );
    if (profile.governance?.approvalRequired && !runContract)
      throw new Error("Profile requires an approved run contract to resume");
    if (runContract) {
      if (runContract.sessionId !== sessionId)
        throw new Error(
          "Run contract session does not match the session being resumed",
        );
      authorizeRun(sessionStore, runContract);
    }
    const plan = buildExecutionPlan(profile, {
      cwd: existing.workingDirectory,
      supportedTransports: runtimeTransports,
      writeAllowed: false,
    });
    sessionStore.updateStatus(sessionId, "running");
    appendExecutionPlan(sessionStore, sessionId, plan);
    sessionStore.appendEvent(
      sessionId,
      "resume_requested",
      redactRuntimeText(prompt),
    );
    sessionStore.appendEvent(
      sessionId,
      "user_input",
      redactRuntimeText(prompt),
    );
    // The first turn's prompt points at skill folders, context references and possibly the
    // facts store; --add-dir is per invocation, so the same grant is rebuilt for the resume.
    // profileIdentity is unchanged (checked above), so the skill set is the same. The grant
    // only adds read access: a skill or facts lookup that fails now narrows it, never the turn.
    const cwd = existing.workingDirectory;
    let skillIndex: SkillIndexEntry[] = [];
    try {
      skillIndex = await deps.loadSkillIndex(profile.skills, cwd);
    } catch {
      skillIndex = [];
    }
    let factsPartial = false;
    try {
      factsPartial = plan.memoryNamespace
        ? buildProfileFactsDigest(
            plan.memoryNamespace,
            await readProfileFacts(plan.memoryNamespace),
          ).partial
        : false;
    } catch {
      factsPartial = false;
    }
    const readDirectories = headlessReadDirectories({
      cwd,
      profileName: profile.name,
      skillIndex,
      factsPartial,
      contextDirectories: await referenceReadDirectories(
        recordedReferences(sessionStore.listEvents(sessionId)),
        profile.allowedPaths,
        cwd,
      ),
    });
    const result = await execute({
      provider: "claude",
      prompt,
      cwd,
      resumeId: existing.providerSessionId,
      clientHome: deps.resolveClientHome(profile),
      timeoutMs: runContract?.budget.timeoutMs,
      maxOutputBytes: runContract?.budget.maxOutputBytes,
      readOnly: plan.readOnly,
      readDirectories,
      onSpawn: (pid) => sessionStore.setProviderPid(sessionId, pid),
      onEvent: (event) => {
        captureProviderSessionId(sessionStore, sessionId, event);
        sessionStore.appendEvent(
          sessionId,
          event.type,
          boundedEventData(event),
        );
      },
    });
    sessionStore.clearProviderPid(sessionId);
    sessionStore.updateStatus(
      sessionId,
      result.exitCode === 0 ? "completed" : "failed",
    );
    sessionStore.appendEvent(
      sessionId,
      "process_exit",
      JSON.stringify({
        exitCode: result.exitCode,
        stderr: redactRuntimeText(result.stderr),
      }),
    );
    sessionStore.scanCaptureItems(sessionId);
    await finalizeSession(sessionStore, sessionId, {
      exitCode: result.exitCode,
    });
    return sessionStore.get(sessionId) ?? existing;
  } catch (error) {
    sessionStore.clearProviderPid(sessionId);
    sessionStore.updateStatus(sessionId, "failed");
    sessionStore.scanCaptureItems(sessionId);
    sessionStore.appendEvent(
      sessionId,
      "error",
      redactRuntimeText(error instanceof Error ? error.message : String(error)),
    );
    await finalizeSession(sessionStore, sessionId, { exitCode: 1 });
    throw error;
  } finally {
    sessionStore.close();
  }
}

// Only CLI clients execute today; API bindings fail closed until their transport lands.
// Writes stay off (writeAllowed: false) until each provider's sandbox is enforced.
const runtimeTransports = ["cli"] as const;

// The plan is recorded with its identity before any context is assembled or process starts,
// so a session always shows the exact client, model, memory namespace and sandbox it ran with.
function appendExecutionPlan(
  store: SessionStorePort,
  sessionId: string,
  plan: ExecutionPlan,
): void {
  store.appendEvent(
    sessionId,
    "execution_plan",
    JSON.stringify({ identity: executionPlanIdentity(plan), plan }),
  );
}

// Read access for everything the lean prompt points at outside cwd: skill folders, the
// facts store when the digest left facts out, and the allowedPaths-bounded directories of
// context references. Deduped in that order.
function headlessReadDirectories(options: {
  cwd: string;
  profileName: string;
  skillIndex: SkillIndexEntry[];
  factsPartial: boolean;
  contextDirectories: string[];
}): string[] {
  return [
    ...new Set([
      ...readDirectoriesOutside(options.cwd, [
        ...options.skillIndex.map((skill) => skill.path),
        ...(options.factsPartial
          ? [profileFactsFile(options.profileName)]
          : []),
      ]),
      ...options.contextDirectories,
    ]),
  ];
}

// The references the session's first turn recorded (its last context_manifest event).
// Packet references depend on the original prompt, so they are read back, not recomputed.
function recordedReferences(
  events: { type: string; data: string }[],
): ContextReference[] {
  const manifest = [...events]
    .reverse()
    .find((event) => event.type === "context_manifest");
  if (!manifest) return [];
  try {
    return validateContextManifest(JSON.parse(manifest.data)).references;
  } catch {
    return [];
  }
}

function boundedEventData(event: RuntimeEvent): string {
  const serialized =
    typeof event.data === "string" ? event.data : JSON.stringify(event.data);
  return redactRuntimeText(serialized);
}

function captureProviderSessionId(
  store: SessionStorePort,
  sessionId: string,
  event: RuntimeEvent,
): void {
  if (
    event.type === "json" &&
    typeof event.data === "object" &&
    event.data !== null &&
    "session_id" in event.data
  ) {
    const providerSessionId = (event.data as { session_id?: unknown })
      .session_id;
    if (
      typeof providerSessionId === "string" &&
      isValidProviderSessionId(providerSessionId)
    )
      store.updateProviderSessionId(sessionId, providerSessionId);
  }
}

export function isValidProviderSessionId(value: string): boolean {
  return value.length <= 256 && /^[A-Za-z0-9._:-]+$/.test(value);
}
