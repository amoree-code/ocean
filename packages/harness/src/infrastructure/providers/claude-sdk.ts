import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type {
  HeadlessResult,
  RuntimeEvent,
} from "@ocean/core/domain/process/process-events.js";
import type { ProviderRequest } from "@ocean/core/domain/providers/provider.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "../process/cli-process.js";
import { ownsGroup, superviseProcess } from "../process/process-supervisor.js";
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

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("exit", resolve));
}

// One headless Claude turn through the Agent SDK, with the same contract as every CLI provider:
// Ocean spawns the process (so the session store gets its pid and its environment is the
// plan's), every SDK message becomes a `json` event, and the run's timeout (124) and output
// budget (125) end it exactly as they end any other provider, through the same supervisor.
export async function runClaudeSdk(
  request: ProviderRequest,
): Promise<HeadlessResult> {
  const executable = resolveOriginalExecutable("claude");
  // The SDK loads only when Claude actually runs, not on every `ocean` command.
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const abortController = new AbortController();
  const events: RuntimeEvent[] = [];
  let terminating = false;
  const supervision = superviseProcess({
    timeoutMs: request.timeoutMs ?? 60_000,
    maxOutputBytes: request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    onTerminate: () => {
      terminating = true;
      abortController.abort();
    },
    // JSON lines reach us as the SDK's messages; lines that are not JSON never do (a crash
    // notice, a plain-text warning), so keep those as text events, as the CLI runner does.
    onLine: (line) => {
      try {
        JSON.parse(line);
      } catch {
        const event: RuntimeEvent = { type: "text", data: line };
        events.push(event);
        request.onEvent?.(event);
      }
    },
  });
  let child: ChildProcess | undefined;
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
              detached: ownsGroup,
              windowsHide: true,
            });
            child = spawned;
            supervision.attach(spawned);
            if (spawned.pid) request.onSpawn?.(spawned.pid);
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
    // After a forced stop the run no longer waits on the SDK, whose message stream may never
    // settle once its process and pipes are gone.
    await Promise.race([consumed, supervision.released]);
    if (!supervision.spawnError && child) code = await exited(child);
  } finally {
    supervision.finish();
  }
  if (supervision.spawnError && !supervision.timedOut)
    throw supervision.spawnError;
  supervision.flush();
  const stopped = supervision.timedOut || supervision.outputLimitExceeded;
  return {
    exitCode:
      stopped || !child || code === null
        ? supervision.exitCode(child ? code : null)
        : code !== 0
          ? code
          : failure || errorResult
            ? 1
            : 0,
    events,
    stderr:
      supervision.stderr +
      (stopped ? supervision.stopNote : failure ? `${failure}\n` : ""),
  };
}
