import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type {
  HeadlessResult,
  RuntimeEvent,
} from "@ocean/core/domain/process/process-events.js";
import type { ProviderRequest } from "@ocean/core/domain/providers/provider.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "../process/cli-process.js";
import { resolveOriginalExecutable } from "./provider-registry.js";

// The plan's model, unless it leaves the client's own default ("provider-managed" or absent).
export function explicitModel(model: string | undefined): string | undefined {
  return model && model !== "provider-managed" ? model : undefined;
}

// A Claude request as Claude Agent SDK options. The SDK turns them into Claude Code's own flags
// (--resume, --model, --permission-mode, --add-dir) and speaks its stream protocol, so Ocean no
// longer builds `claude -p` arguments or parses its output itself.
export function claudeSdkOptions(
  request: ProviderRequest,
  executable: string,
): Options {
  const model = explicitModel(request.model);
  return {
    // The user's own Claude Code, past Ocean's shims, never the SDK's bundled copy.
    pathToClaudeCodeExecutable: executable,
    cwd: path.resolve(request.cwd),
    // Built fresh for every run, as for every provider: the plan's variables over this process's.
    env: { ...process.env, ...request.env },
    // Claude Code's own system prompt, as `claude -p` has it. Left unset, the SDK sends an empty one.
    // Settings and CLAUDE.md need nothing: an unset settingSources loads every source, as the CLI does.
    systemPrompt: { type: "preset", preset: "claude_code" },
    ...(request.resumeId ? { resume: request.resumeId } : {}),
    ...(model ? { model } : {}),
    // Read-only is enforced with Claude Code's own controls, never only asked for in the prompt.
    ...(request.readOnly
      ? { permissionMode: "plan", extraArgs: { restricted: null } }
      : {}),
    ...(request.readDirectories?.length
      ? { additionalDirectories: request.readDirectories }
      : {}),
  };
}

// Claude Code runs as its own process group, so a timeout or budget stop ends everything it
// started (a tool's subprocess too), not just the leader: a surviving descendant would hold the
// output pipe open and keep the run waiting.
const ownGroup = process.platform !== "win32";
const forwardedSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

function signalTree(child: ChildProcess | undefined, signal: NodeJS.Signals) {
  if (!child?.pid) return;
  try {
    if (ownGroup) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // Already gone.
  }
}

// Out of the terminal's process group, a run no longer receives this process's Ctrl+C or
// kill directly; pass them on, then let the signal do what it would have done here. One set of
// listeners serves every run in flight, so many concurrent runs never trip Node's listener warning.
const active = new Set<ChildProcess>();
let listening = false;
const onExit = () => {
  for (const child of active) signalTree(child, "SIGTERM");
};
const onSignal = (signal: NodeJS.Signals) => {
  onExit();
  unlisten();
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
};
function unlisten(): void {
  if (!listening) return;
  listening = false;
  process.off("exit", onExit);
  for (const signal of forwardedSignals) process.off(signal, onSignal);
}
function endWithThisProcess(child: ChildProcess): () => void {
  if (!listening) {
    listening = true;
    process.once("exit", onExit);
    for (const signal of forwardedSignals) process.on(signal, onSignal);
  }
  active.add(child);
  return () => {
    active.delete(child);
    if (active.size === 0) unlisten();
  };
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("exit", resolve));
}

// How long output still in the pipe gets, once Claude itself has exited, before whatever else
// holds the pipe open (a background process it left behind) is stopped and no longer awaited.
const LINGER_MS = 500;

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
  let release = () => {};
  let spawnError: Error | undefined;
  // Settles once a stop has been forced. After that the run no longer waits on the SDK, whose
  // message stream may never settle once its process and pipes are gone.
  let forced = () => {};
  const stopped = new Promise<void>((resolve) => {
    forced = resolve;
  });
  // Whatever still holds the pipes (a descendant that left the group) no longer holds the run.
  const letGo = (): void => {
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    forced();
  };
  let terminating = false;
  let killTimer: NodeJS.Timeout | undefined;
  let lingerTimer: NodeJS.Timeout | undefined;
  const terminate = (): void => {
    if (terminating) return;
    terminating = true;
    abortController.abort();
    signalTree(child, "SIGTERM");
    // Not unref'd: this timer keeps the process alive until the run has been let go.
    killTimer = setTimeout(() => {
      signalTree(child, "SIGKILL");
      letGo();
    }, 100);
  };
  // Raw stdout and stderr bytes count against one budget as they arrive, before the SDK
  // buffers a line, so a huge or unterminated line cannot grow past the cap.
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
  // Lines that are not JSON never reach the SDK's messages (a crash notice, a plain-text
  // warning); keep them as text events, as the CLI runner does.
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const emitText = (line: string): void => {
    if (!line) return;
    try {
      JSON.parse(line);
    } catch {
      const event: RuntimeEvent = { type: "text", data: line };
      events.push(event);
      request.onEvent?.(event);
    }
  };
  const teeStdout = (chunk: Buffer): void => {
    pending += decoder.write(chunk);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) emitText(line);
  };
  // Armed until the process has closed, not just until the SDK stops yielding.
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, request.timeoutMs ?? 60_000);

  let failure: string | undefined;
  let errorResult = false;
  let code: number | null = null;
  try {
    const consumed = (async () => {
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
              windowsHide: true,
            });
            child = spawned;
            if (ownGroup) release = endWithThisProcess(spawned);
            if (spawned.pid) request.onSpawn?.(spawned.pid);
            // A failed start (no such executable) is a rejected run, as for the CLI runner; the abort
            // of a stop we asked for is not a failure.
            spawned.once("error", (error) => {
              if (terminating) return;
              spawnError = error;
              letGo();
            });
            spawned.once("exit", () => {
              if (!terminating) lingerTimer = setTimeout(letGo, LINGER_MS);
            });
            spawned.stdout.on("data", (chunk: Buffer) => {
              if (withinBudget(chunk.byteLength)) teeStdout(chunk);
            });
            spawned.stderr.on("data", (chunk: Buffer) => {
              if (withinBudget(chunk.byteLength))
                stderr += chunk.toString("utf8");
            });
            return spawned;
          },
        },
      });
      for await (const message of messages) {
        if (terminating) break;
        const event: RuntimeEvent = { type: "json", data: message };
        events.push(event);
        request.onEvent?.(event);
        if (message.type === "result" && message.is_error) errorResult = true;
      }
    })().catch((error: unknown) => {
      failure = error instanceof Error ? error.message : String(error);
    });
    await Promise.race([consumed, stopped]);
    if (!spawnError && child) code = await exited(child);
  } finally {
    clearTimeout(timer);
    clearTimeout(lingerTimer);
    clearTimeout(killTimer);
    // The leader is gone; end anything it left in the group, then stop watching it.
    signalTree(child, "SIGKILL");
    release();
  }
  if (spawnError && !timedOut) throw spawnError;
  emitText(pending + decoder.end());
  return {
    exitCode: timedOut
      ? 124
      : outputLimitExceeded
        ? 125
        : // A process ended by a signal has no exit code: that is a failure, as for every provider.
          !child || code === null
          ? 1
          : code !== 0
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
