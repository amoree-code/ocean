import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  authAdapter,
  authLogin,
  authStatus,
} from "../../application/auth/auth-orchestrator.js";
import { resolveProject } from "../../application/context/project-resolution.js";
import {
  bootstrapEnvironment,
  buildOceanBootstrap,
} from "../../application/context/resource-injection.js";
import { finalizeSession } from "../../application/memory/session-closeout.js";
import { authorizeRun } from "../../application/runs/run-authorization.js";
import { defaultAuthDeps } from "../../composition/runtime.js";
import {
  type Profile,
  profileIdentity,
} from "../../domain/profiles/profile.js";
import { validateRunContract } from "../../domain/runs/run-contract.js";
import { validateSessionEntryContract } from "../../domain/sessions/entry-contract.js";
import { redactRuntimeText } from "../../infrastructure/observability/runtime-logger.js";
import { openSessionStore } from "../../infrastructure/persistence/session-store.js";
import {
  type InteractiveProcessResult,
  runInteractive,
  runPassthrough,
} from "../../infrastructure/process/interactive-process.js";
import {
  findProvider,
  resolveOriginalExecutable,
  validateExplicitExecutable,
} from "../../infrastructure/providers/provider-registry.js";
import { oceanEnvPair } from "../../paths.js";

export type InterceptOptions = {
  entryPoint?: "terminal-shim" | "interactive-managed" | "desktop-wrapper";
  controlLevel?: "observed" | "managed-partial";
  originalExecutable?: string;
  title?: string;
  taskId?: string;
  handoffId?: string;
};

export async function intercept(
  command: string,
  args: string[],
  options: InterceptOptions = {},
): Promise<number> {
  const provider = findProvider(command);
  if (provider.enabled === false || isUtilityInvocation(provider.id, args)) {
    const executable = options.originalExecutable
      ? validateExplicitExecutable(options.originalExecutable)
      : resolveOriginalExecutable(provider.command);
    const result = await runPassthrough({
      command: executable,
      args,
      cwd: path.resolve(process.cwd()),
      env: oceanEnvPair("INTERCEPTED", "1"),
    });
    return result.exitCode;
  }
  const entryPoint =
    options.entryPoint ??
    (options.originalExecutable ? "desktop-wrapper" : "terminal-shim");
  const controlLevel =
    options.controlLevel ??
    (options.originalExecutable ? "managed-partial" : "observed");
  const inputCapture = options.originalExecutable ? "none" : "bounded-terminal";
  const sessionId = randomUUID();
  const profile = interceptedProfile(provider.id);
  const store = await openSessionStore();
  const workingDirectory = path.resolve(process.cwd());
  const projectResolution = await resolveProject(workingDirectory);
  const bootstrap = buildOceanBootstrap(projectResolution);
  const runId = randomUUID();
  const contract = validateRunContract({
    runId,
    sessionId,
    profile: profile.name,
    workingDirectory,
    allowedTools: [provider.command],
    deniedTools: [],
    stopConditions: ["provider-process-exits"],
    approval: { required: false, approved: true },
    budget: {
      timeoutMs: 24 * 60 * 60 * 1000,
      maxAttempts: 1,
      maxOutputBytes: 64_000,
    },
  });

  store.create({
    sessionId,
    title: options.title ?? `${provider.id} session`,
    taskId: options.taskId ?? null,
    handoffId: options.handoffId ?? null,
    provider: provider.id,
    providerSessionId: null,
    parentSessionId: null,
    profile: profile.name,
    profileIdentity: profileIdentity(profile),
    workingDirectory,
    resumeData: null,
    projectId:
      projectResolution.status === "bound" ? projectResolution.projectId : null,
  });
  store.appendEvent(
    sessionId,
    "session_entry_contract",
    JSON.stringify(
      validateSessionEntryContract({
        entryPoint,
        controlLevel,
        inputCapture,
        contextTransport: options.originalExecutable
          ? "desktop-passthrough"
          : bootstrap.manifest.transport,
        policyEnforcement: "shim-lifecycle-and-provider-owned-policy",
        promotion: "explicit-review",
        resume:
          provider.id === "claude"
            ? "provider-owned-if-exposed"
            : "unsupported",
      }),
    ),
  );
  store.appendEvent(
    sessionId,
    "intercept_requested",
    JSON.stringify({
      runId,
      command: provider.command,
      args: args.map(redactRuntimeText),
    }),
  );
  if (options.handoffId)
    store.appendEvent(
      sessionId,
      "handoff_bound",
      JSON.stringify({
        handoffId: options.handoffId,
        taskId: options.taskId ?? null,
      }),
    );
  store.appendEvent(
    sessionId,
    "project_resolved",
    JSON.stringify({ workingDirectory, ...projectResolution }),
  );
  store.appendEvent(
    sessionId,
    "ocean_bootstrap",
    JSON.stringify({
      provider: provider.id,
      ...bootstrap.manifest,
    }),
  );

  try {
    store.updateStatus(sessionId, "running");
    authorizeRun(store, contract);
    const executable = options.originalExecutable
      ? validateExplicitExecutable(options.originalExecutable)
      : resolveOriginalExecutable(provider.command);
    const authState = await authStatus(provider.id, defaultAuthDeps);
    store.appendEvent(
      sessionId,
      "auth_state",
      JSON.stringify({ provider: provider.id, state: authState }),
    );
    if (authState === "login_required") {
      store.appendEvent(
        sessionId,
        "auth_login_started",
        JSON.stringify({ provider: provider.id }),
      );
      const verifiedState = await authLogin(provider.id, defaultAuthDeps);
      store.appendEvent(
        sessionId,
        "auth_state",
        JSON.stringify({ provider: provider.id, state: verifiedState }),
      );
      if (verifiedState !== "authenticated") {
        store.updateStatus(sessionId, "failed");
        store.appendEvent(
          sessionId,
          "evidence",
          JSON.stringify({
            sessionId,
            type: "auth",
            source: "ocean-interceptor",
            result: "blocked_by_client_authentication",
            criterion: "provider login did not verify successfully",
          }),
        );
        await finalizeSession(store, sessionId, { exitCode: 1 });
        return 1;
      }
    }
    store.appendEvent(
      sessionId,
      "provider_resolved",
      JSON.stringify({ executable, runtime: "direct" }),
    );
    const processRequest = {
      command: provider.command,
      args,
      cwd: workingDirectory,
      environment: {
        ...oceanEnvPair("INTERCEPTED", "1"),
        ...bootstrapEnvironment(bootstrap),
      },
    };
    const runProvider = async (signal: AbortSignal) =>
      await (options.originalExecutable ? runPassthrough : runInteractive)({
        command: executable,
        args,
        cwd: workingDirectory,
        env: processRequest.environment,
        signal,
        onData: (data) =>
          store.appendEvent(
            sessionId,
            "provider_output",
            redactRuntimeText(data),
          ),
        onInput: (data) =>
          store.appendEvent(
            sessionId,
            "terminal_input",
            redactRuntimeText(data),
          ),
      });
    const abortController = new AbortController();
    let terminationSignal: NodeJS.Signals | undefined;
    const onTermination = (signal: NodeJS.Signals): void => {
      terminationSignal = signal;
      abortController.abort();
    };
    process.once("SIGINT", onTermination);
    process.once("SIGTERM", onTermination);
    let result: InteractiveProcessResult;
    try {
      result = await runProvider(abortController.signal);
    } finally {
      process.off("SIGINT", onTermination);
      process.off("SIGTERM", onTermination);
    }
    const exitCode = terminationSignal
      ? terminationSignal === "SIGINT"
        ? 130
        : 143
      : result.exitCode;
    let evidence = classifyProviderResult(exitCode, result.output);
    if (
      evidence.result === "blocked_by_client_authentication" &&
      authAdapter(provider.id)
    ) {
      store.appendEvent(
        sessionId,
        "auth_recovery_started",
        JSON.stringify({ provider: provider.id, reason: evidence.criterion }),
      );
      const recoveredState = await authLogin(provider.id, defaultAuthDeps);
      store.appendEvent(
        sessionId,
        "auth_state",
        JSON.stringify({
          provider: provider.id,
          state: recoveredState,
          phase: "recovery",
        }),
      );
      if (recoveredState === "authenticated") {
        store.appendEvent(
          sessionId,
          "run_resumed",
          JSON.stringify({
            provider: provider.id,
            reason: "authentication verified",
          }),
        );
        result = await runProvider(new AbortController().signal);
        if (result.output)
          store.appendEvent(
            sessionId,
            "provider_output",
            redactRuntimeText(result.output),
          );
        evidence = classifyProviderResult(result.exitCode, result.output);
      }
    }
    const finalExitCode = terminationSignal ? exitCode : result.exitCode;
    const status = finalExitCode === 0 ? "completed" : "failed";
    store.updateStatus(sessionId, status);
    store.appendEvent(
      sessionId,
      "process_exit",
      JSON.stringify({
        exitCode: finalExitCode,
        signal: terminationSignal ?? null,
      }),
    );
    if (evidence.result === "blocked_by_client_authentication") {
      store.appendEvent(
        sessionId,
        "provider_blocked",
        JSON.stringify({ reason: evidence.criterion }),
      );
    }
    store.appendEvent(
      sessionId,
      "evidence",
      JSON.stringify({
        sessionId,
        type: "provider_exit",
        source: "ocean-interceptor",
        result: evidence.result,
        criterion: evidence.criterion,
      }),
    );
    store.scanCaptureItems(sessionId);
    await finalizeSession(store, sessionId, {
      exitCode: finalExitCode,
      nextAction: terminationSignal
        ? `Session ended by ${terminationSignal}.`
        : undefined,
    });
    return finalExitCode;
  } catch (error) {
    store.updateStatus(sessionId, "failed");
    store.appendEvent(
      sessionId,
      "error",
      redactRuntimeText(error instanceof Error ? error.message : String(error)),
    );
    await finalizeSession(store, sessionId, { exitCode: 1 });
    throw error;
  } finally {
    store.close();
  }
}

const UTILITY_FLAGS = new Set(["--help", "-h", "--version", "-v", "-V"]);

// Management subcommands that never start a working session. `attach` and
// `ultrareview` are excluded on purpose: both are real work.
const UTILITY_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  claude: new Set([
    "agents",
    "auth",
    "auto-mode",
    "doctor",
    "gateway",
    "import",
    "install",
    "logs",
    "mcp",
    "plugin",
    "plugins",
    "project",
    "respawn",
    "rm",
    "setup-token",
    "stop",
    "kill",
    "update",
    "upgrade",
  ]),
};

/**
 * True when an invocation is a lookup or management command (a version check,
 * `claude agents --json` polled by a desktop client, `claude mcp list`) rather
 * than a working session. These run straight through without a session record,
 * which otherwise floods the store with hundreds of empty summaries a day.
 */
export function isUtilityInvocation(
  providerId: string,
  args: readonly string[],
): boolean {
  const first = args[0];
  if (first === undefined) return false;
  if (args.length === 1 && UTILITY_FLAGS.has(first)) return true;
  return UTILITY_SUBCOMMANDS[providerId]?.has(first) ?? false;
}

function classifyProviderResult(
  exitCode: number,
  output: string,
): { result: string; criterion: string } {
  if (exitCode === 0)
    return {
      result: "proven",
      criterion: "intercepted provider process exits successfully",
    };
  if (
    /401\s+Unauthorized|missing bearer|not logged in|sign in to use/i.test(
      output,
    )
  ) {
    return {
      result: "blocked_by_client_authentication",
      criterion: "provider authentication is required",
    };
  }
  return {
    result: "not_proven",
    criterion: "intercepted provider process exits successfully",
  };
}

function interceptedProfile(provider: string): Profile {
  return {
    schemaVersion: 1,
    name: `intercepted:${provider}`,
    description: "Ocean transparent CLI interception profile",
    version: "1.0.0",
    provider: provider as Profile["provider"],
    model: "provider-managed",
    role: "intercepted worker",
    skills: [],
    allowedPaths: ["."],
    allowedCommands: [],
    writePolicy: "none",
    contextSources: [],
    clients: {
      [provider]: { enabled: true, capabilities: [], limitations: [] },
    },
    defaultClient: provider as Profile["provider"],
    memory: { enabled: true, scope: "profile" },
    verification: { commands: [] },
    contextCompression: "none",
    instructions: "",
  };
}
