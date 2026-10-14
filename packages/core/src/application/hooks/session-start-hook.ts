import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { truncateUtf8 } from "../../fs-utils.js";
import { oceanRoot, SYSTEM_DIR } from "../../paths.js";
import {
  gitChangedFiles,
  resolveProject,
} from "../context/project-resolution.js";
import { buildOceanBootstrap } from "../context/resource-injection.js";

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
// 256-byte bootstrap. Anything that goes wrong here means no warning, never a failed hook.
export async function oceanWorktreeWarning(
  cwd: string,
): Promise<string | null> {
  try {
    const root = await realpath(oceanRoot());
    const here = await realpath(cwd);
    if (here !== root && !here.startsWith(`${root}${path.sep}`)) return null;
    const changed = (await gitChangedFiles(here, 3_000)).length;
    if (!changed) return null;
    // House convention: worktrees live beside the workspace, e.g. ~/ocean-worktrees/<slug>.
    const home = os.homedir();
    const worktrees = path.join(
      path.dirname(root),
      `${path.basename(root)}-worktrees`,
    );
    const shown = worktrees.startsWith(`${home}${path.sep}`)
      ? `~${worktrees.slice(home.length)}`
      : worktrees;
    const line = (dir: string) =>
      `ocean-dirty=${changed}: uncommitted changes already here. Change files in a worktree: git worktree add ${dir}${path.sep}<slug> -b <branch>`;
    // Never cut the command in half: a path too long for the bound becomes a placeholder.
    const full = line(shown);
    return Buffer.byteLength(full) <= WORKTREE_WARNING_MAX_BYTES
      ? full
      : truncateUtf8(
          line(`<${path.basename(root)}-worktrees>`),
          WORKTREE_WARNING_MAX_BYTES,
        );
  } catch {
    return null;
  }
}

export async function claudeSessionStartHook(
  payload: ClaudeSessionStartPayload,
): Promise<ClaudeSessionStartResult> {
  const cwd = payload.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const [project, warning] = await Promise.all([
    resolveProject(cwd),
    oceanWorktreeWarning(cwd),
  ]);
  const bootstrap = buildOceanBootstrap(project);
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: warning
        ? `${bootstrap.content}\n${warning}`
        : bootstrap.content,
    },
  };
}

// Clients that take the bootstrap through their own hooks instead of a same-name shim (T-266).
// Codex reads Claude Code's hookSpecificOutput shape. Hermes injects context only from a
// pre_llm_call shell hook, as {"context": "..."} (hermes agent/shell_hooks.py _parse_response).
export const SESSION_START_CLIENTS = ["claude", "codex", "hermes"] as const;
export type SessionStartClient = (typeof SESSION_START_CLIENTS)[number];

export function isSessionStartClient(
  value: string,
): value is SessionStartClient {
  return (SESSION_START_CLIENTS as readonly string[]).includes(value);
}

export async function sessionStartHookForClient(
  client: SessionStartClient,
  payload: ClaudeSessionStartPayload,
): Promise<ClaudeSessionStartResult | { context: string }> {
  const result = await claudeSessionStartHook(payload);
  return client === "hermes"
    ? { context: result.hookSpecificOutput.additionalContext }
    : result;
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
