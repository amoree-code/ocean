import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildOceanBootstrap } from "@ocean/context/context/resource-injection.js";
import { truncateUtf8 } from "@ocean/core/shared/fs-utils.js";
import { oceanRoot, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import {
  autoRegisterProject,
  gitChangedFiles,
  type ProjectManifest,
  type ProjectResolution,
  projectRules,
  readProjectManifest,
  resolveProject,
  scanProjectManifests,
} from "@ocean/core/shared/project-resolution.js";

// The documented Claude Code SessionStart hook contract on this machine (verified against
// the live ~/.claude/settings.json hook entries, e.g. the existing ai-guard-push PreToolUse
// hook): a hook reads a small JSON payload on stdin and may print
// {"hookSpecificOutput": {"hookEventName": "...", "additionalContext": "..."}} on stdout.
// additionalContext is the only thing Ocean adds — never file content, never a transcript.
export type ClaudeSessionStartPayload = {
  cwd?: string;
  session_id?: string;
  hook_event_name?: string;
};

export type ClaudeSessionStartResult = {
  hookSpecificOutput: {
    hookEventName: "SessionStart";
    additionalContext: string;
  };
};

const MAX_STDIN_BYTES = 65_536;

export async function readBoundedStdin(
  stream: NodeJS.ReadStream = process.stdin,
  maxBytes = MAX_STDIN_BYTES,
): Promise<string> {
  if (stream.isTTY) return "";
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes)
      throw new Error(
        `Session-start hook payload exceeds the ${maxBytes}-byte bound`,
      );
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const WORKTREE_WARNING_MAX_BYTES = 200;

// Sessions share the Ocean working tree, so one session's `git add -A` can capture another's
// in-progress files (T-257). When a session starts inside the Ocean workspace and its repo
// already has uncommitted changes, say so in one bounded line, beside — not inside — the
// 256-byte bootstrap. The line points at `ocean tasks claim`, not at a worktree (owner decision
// 2026-10-16: no worktrees; changes must stay visible in the one folder). Anything that goes wrong here means no warning, never a failed hook.
export async function oceanWorktreeWarning(
  cwd: string,
): Promise<string | null> {
  try {
    const root = await realpath(oceanRoot());
    const here = await realpath(cwd);
    if (here !== root && !here.startsWith(`${root}${path.sep}`)) return null;
    const changed = (await gitChangedFiles(here, 3_000)).length;
    if (!changed) return null;
    // Those changes are another live session's: never stash, commit or `git add -A` them. The
    // way to avoid colliding is to claim the task (and the dirs) before editing (T-270).
    const line = `ocean-dirty=${changed}: other sessions' uncommitted changes here; never stash/commit/add -A them. Claim first: ocean tasks claim <ID> --by <you> --paths <dirs>`;
    return truncateUtf8(line, WORKTREE_WARNING_MAX_BYTES);
  } catch {
    return null;
  }
}

// The first session in an unregistered repo under a code root registers it (T-256 phase 2).
// Best-effort: a failure here leaves the session unbound, never fails the hook.
async function registerIfUnbound(
  cwd: string,
  resolved: ProjectResolution,
): Promise<ProjectResolution> {
  if (resolved.status !== "unbound") return resolved;
  try {
    return (await autoRegisterProject(cwd, { resolution: resolved }))
      .resolution;
  } catch {
    return resolved;
  }
}

// The bound project's manifest, read best-effort: a broken manifest costs the session its
// rules, never its bootstrap (the same contract as the registry above) — and says so.
export async function boundProjectManifest(
  project: ProjectResolution,
): Promise<{ manifest: ProjectManifest | null; problem: string | null }> {
  if (project.status !== "bound") return { manifest: null, problem: null };
  try {
    return {
      manifest: await readProjectManifest(project.projectId),
      problem: null,
    };
  } catch (error) {
    return {
      manifest: null,
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

// An unbound session may be unbound only because its project's manifest does not parse; its
// rules would then vanish without a word. Name the unreadable manifests (at most three).
async function unreadableManifestsWarning(): Promise<string | null> {
  try {
    const { errors } = await scanProjectManifests();
    if (!errors.length) return null;
    const named = errors
      .slice(0, 3)
      .map(
        ({ file, error }) => `${path.relative(oceanRoot(), file)} (${error})`,
      )
      .join("; ");
    return `Ocean: ${errors.length} project manifest(s) unreadable, those projects are unbound and their rules not loaded: ${named}`;
  } catch {
    return null;
  }
}

// Hard constraints must hold from turn one, so the rules themselves ride beside the bootstrap
// (at most 10 lines of 200 bytes), not just a count.
export function projectRulesBlock(
  projectId: string,
  rules: readonly string[],
): string {
  return `Project rules (${projectId}):\n${rules.map((rule) => `- ${rule}`).join("\n")}`;
}

export async function claudeSessionStartHook(
  payload: ClaudeSessionStartPayload,
): Promise<ClaudeSessionStartResult> {
  // `||`, not `??`: Hermes sends cwd "" when its own cwd is unreadable.
  const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const [resolved, warning] = await Promise.all([
    // A broken registry must cost this session its project, never its bootstrap.
    resolveProject(cwd).catch(
      (): ProjectResolution => ({
        status: "unbound",
        cwd: path.resolve(cwd),
        gitRoot: null,
        confidence: "none",
      }),
    ),
    oceanWorktreeWarning(cwd),
  ]);
  const project = await registerIfUnbound(cwd, resolved);
  const { manifest, problem } = await boundProjectManifest(project);
  let rules: string[] = [];
  let rulesProblem: string | null = problem;
  if (manifest)
    try {
      rules = projectRules(manifest);
    } catch (error) {
      rulesProblem = error instanceof Error ? error.message : String(error);
    }
  const bootstrap = buildOceanBootstrap(project, { rules: rules.length });
  const parts = [bootstrap.content];
  if (project.status === "bound" && rules.length)
    parts.push(projectRulesBlock(project.projectId, rules));
  // Fail visible: rules that cannot be read are said so, never silently dropped.
  if (project.status === "bound" && rulesProblem)
    parts.push(
      `Project rules (${project.projectId}) unreadable: ${rulesProblem} — fix 04-projects/${project.projectId}/project.json`,
    );
  if (project.status !== "bound") {
    const unreadable = await unreadableManifestsWarning();
    if (unreadable) parts.push(unreadable);
  }
  if (warning) parts.push(warning);
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: parts.join("\n"),
    },
  };
}

// Clients that take the bootstrap through their own hooks instead of a same-name shim (T-266).
// Codex reads Claude Code's hookSpecificOutput shape. Hermes injects context only from a
// pre_llm_call shell hook, as {"context": "..."} (hermes agent/shell_hooks.py _parse_response);
// that hook fires on every turn, so only the first turn gets the bootstrap.
export const SESSION_START_CLIENTS = ["claude", "codex", "hermes"] as const;
export type SessionStartClient = (typeof SESSION_START_CLIENTS)[number];

export function isSessionStartClient(
  value: string,
): value is SessionStartClient {
  return (SESSION_START_CLIENTS as readonly string[]).includes(value);
}

// Hermes' payload: {hook_event_name, tool_name, tool_input, session_id, cwd, extra}, where
// extra.is_first_turn is false on every turn after the first (agent/turn_context.py).
export type SessionStartPayload = ClaudeSessionStartPayload & {
  extra?: { is_first_turn?: boolean };
};

export async function sessionStartHookForClient(
  client: SessionStartClient,
  payload: SessionStartPayload,
): Promise<ClaudeSessionStartResult | { context?: string }> {
  if (client !== "hermes") return claudeSessionStartHook(payload);
  // Later turns: no context and no git/project work on Hermes' per-turn hot path.
  if (payload.extra?.is_first_turn === false) return {};
  const result = await claudeSessionStartHook(payload);
  return { context: result.hookSpecificOutput.additionalContext };
}

export type ClaudeNativeHookStatus = {
  scriptPath: string;
  scriptInstalled: boolean;
  settingsPath: string;
  registered: boolean;
};

// The hook script and its registration are named after the product.
const HOOK_NAMES = ["ocean-session-bootstrap"];
const WORKSPACE_FOLDERS = ["ocean"];

// Read-only status check: does the hook script exist on disk, and is it actually registered
// under hooks.SessionStart in the live Claude Code settings? Registration is never done
// automatically here (see kernel/bridge/integrations/claude-code/hooks/ for the manual-copy
// convention) — this only reports the truth, it never assumes it.
export async function claudeNativeHookStatus(
  homeDir = os.homedir(),
): Promise<ClaudeNativeHookStatus> {
  const candidates = WORKSPACE_FOLDERS.flatMap((folder) =>
    HOOK_NAMES.map((hook) =>
      path.join(
        homeDir,
        folder,
        SYSTEM_DIR,
        "integrations",
        "claude-code",
        "hooks",
        hook,
      ),
    ),
  );
  let scriptPath = candidates[0];
  let scriptInstalled = false;
  for (const candidate of candidates) {
    try {
      await readFile(candidate, "utf8");
      scriptPath = candidate;
      scriptInstalled = true;
      break;
    } catch {
      // try the next known location
    }
  }
  const settingsPath = path.join(homeDir, ".claude", "settings.json");
  let registered = false;
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: string }> }> };
    };
    const entries = settings.hooks?.SessionStart ?? [];
    // When a script is installed, only a registration of that very script counts: a command
    // naming the other hook name would point at a file that is not there and silently fail.
    const wanted = scriptInstalled ? [path.basename(scriptPath)] : HOOK_NAMES;
    registered = entries.some((entry) =>
      (entry.hooks ?? []).some((hook) =>
        wanted.some((name) => hook.command?.includes(name)),
      ),
    );
  } catch {
    registered = false;
  }
  return { scriptPath, scriptInstalled, settingsPath, registered };
}
