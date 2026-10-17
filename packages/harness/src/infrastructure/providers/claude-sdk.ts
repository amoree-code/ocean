import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type {
  HeadlessResult,
  RuntimeEvent,
} from "@ocean/core/domain/process/process-events.js";
import type { ProviderRequest } from "@ocean/core/domain/providers/provider.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "../process/cli-process.js";
import { resolveOriginalExecutable } from "./provider-registry.js";

// A Claude request as Claude Agent SDK options. The SDK turns them into Claude Code's own flags
// (--resume, --model, --permission-mode, --add-dir) and speaks its stream protocol, so Ocean no
// longer builds `claude -p` arguments or parses its output itself.
export function claudeSdkOptions(
  request: ProviderRequest,
  executable: string,
): Options {
  return {
    // The user's own Claude Code, past Ocean's shims, never the SDK's bundled copy.
    pathToClaudeCodeExecutable: executable,
    cwd: path.resolve(request.cwd),
    // Built fresh for every run, as for every provider: the plan's variables over this process's.
    env: { ...process.env, ...request.env },
    ...(request.resumeId ? { resume: request.resumeId } : {}),
    ...(request.model && request.model !== "provider-managed"
      ? { model: request.model }
      : {}),
    // Read-only is enforced with Claude Code's own controls, never only asked for in the prompt.
    ...(request.readOnly
      ? { permissionMode: "plan", extraArgs: { restricted: null } }
      : {}),
    ...(request.readDirectories?.length
      ? { additionalDirectories: request.readDirectories }
      : {}),
  };
}

function closed(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("close", resolve));
}

// Claude Code runs as its own process group, so a timeout or budget stop ends everything it
// started (a tool's subprocess too), not just the leader: a surviving descendant would hold the
// output pipe open and keep the run waiting.
const ownGroup = process.platform !== "win32";

function signalTree(child: ChildProcess | undefined, signal: NodeJS.Signals) {
  if (!child?.pid) return;
  try {
    if (ownGroup) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // Already gone.
  }
}

// One headless Claude turn through the Agent SDK, with the same contract as every CLI provider:
// Ocean spawns the process (so the session store gets its pid and its environment is the
// plan's), every SDK message becomes a `json` event, and the run's timeout (124) and output
// budget (125) end it exactly as they end any other provider.
export async function runClaudeSdk(
  request: ProviderRequest,
): Promise<HeadlessResult> {
  const executable = resolveOriginalExecutable("claude");
  // The SDK loads only when Claude actually runs, not on every `ocean` command.
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const abortController = new AbortController();
  const events: RuntimeEvent[] = [];
  const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  let stderr = "";
  let outputBytes = 0;
  let timedOut = false;
  let outputLimitExceeded = false;
  let child: ChildProcess | undefined;
  const terminate = (): void => {
    abortController.abort();
    signalTree(child, "SIGTERM");
    setTimeout(() => {
      signalTree(child, "SIGKILL");
      // Whatever still holds the pipes (a descendant that left the group) no longer holds the run.
      child?.stdout?.destroy();
      child?.stderr?.destroy();
    }, 100).unref();
  };
  // Messages and stderr count against one budget: an unbounded stderr would defeat the cap.
  const withinBudget = (bytes: number): boolean => {
    if (outputLimitExceeded) return false;
    if (outputBytes + bytes > maxOutputBytes) {
      outputLimitExceeded = true;
      terminate();
      return false;
    }
    outputBytes += bytes;
    return true;
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, request.timeoutMs ?? 60_000);

  let failure: string | undefined;
  let errorResult = false;
  try {
    const messages = query({
      prompt: request.prompt,
      options: {
        ...claudeSdkOptions(request, executable),
        abortController,
        spawnClaudeCodeProcess: (options) => {
          const spawned = spawn(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            signal: options.signal,
            stdio: ["pipe", "pipe", "pipe"],
            detached: ownGroup,
          });
          child = spawned;
          if (spawned.pid) request.onSpawn?.(spawned.pid);
          spawned.stderr.on("data", (chunk: Buffer) => {
            if (withinBudget(chunk.byteLength))
              stderr += chunk.toString("utf8");
          });
          return spawned;
        },
      },
    });
    for await (const message of messages) {
      if (!withinBudget(Buffer.byteLength(JSON.stringify(message)))) break;
      const event: RuntimeEvent = { type: "json", data: message };
      events.push(event);
      request.onEvent?.(event);
      if (message.type === "result" && message.is_error) errorResult = true;
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }
  const code = child ? await closed(child) : null;
  return {
    exitCode: timedOut
      ? 124
      : outputLimitExceeded
        ? 125
        : code !== null && code !== 0
          ? code
          : failure || errorResult
            ? 1
            : 0,
    events,
    stderr: timedOut
      ? `${stderr}Process timed out.\n`
      : outputLimitExceeded
        ? `${stderr}Output budget exceeded.\n`
        : failure
          ? `${stderr}${failure}\n`
          : stderr,
  };
}
