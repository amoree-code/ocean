import { spawn } from "node:child_process";
import type {
  HeadlessRequest,
  HeadlessResult,
  RuntimeEvent,
} from "@ocean/core/domain/process/process-events.js";

// Process contracts live in the domain layer; re-exported here for existing callers.
export type {
  HeadlessRequest,
  HeadlessResult,
} from "@ocean/core/domain/process/process-events.js";

// Applied whenever a caller doesn't pass an explicit maxOutputBytes, so a headless run
// without a budget contract can never buffer unbounded output (disk/memory exhaustion,
// unbounded secret/log capture surface).
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export function runHeadless(request: HeadlessRequest): Promise<HeadlessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid) request.onSpawn?.(child.pid);
    const events: RuntimeEvent[] = [];
    let stdoutBuffer = "";
    let stderr = "";
    let timedOut = false;
    let outputLimitExceeded = false;
    let outputBytes = 0;
    const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const terminate = (): void => {
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 100);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, request.timeoutMs ?? 60_000);

    // Both streams count against the same budget: an unbounded stderr would defeat the
    // point of capping stdout.
    const withinBudget = (chunk: Buffer): boolean => {
      if (outputLimitExceeded) return false;
      if (outputBytes + chunk.byteLength > maxOutputBytes) {
        outputLimitExceeded = true;
        terminate();
        return false;
      }
      outputBytes += chunk.byteLength;
      return true;
    };

    const emitLines = (chunk: Buffer): void => {
      if (!withinBudget(chunk)) return;
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        let event: RuntimeEvent;
        try {
          event = { type: "json", data: JSON.parse(line) };
        } catch {
          event = { type: "text", data: line };
        }
        events.push(event);
        request.onEvent?.(event);
      }
    };

    child.stdout.on("data", emitLines);
    child.stderr.on("data", (chunk: Buffer) => {
      if (!withinBudget(chunk)) return;
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (!timedOut) reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (stdoutBuffer) emitLines(Buffer.from("\n"));
      resolve({
        exitCode: timedOut ? 124 : outputLimitExceeded ? 125 : (exitCode ?? 1),
        events,
        stderr: timedOut
          ? `${stderr}Process timed out.\n`
          : outputLimitExceeded
            ? `${stderr}Output budget exceeded.\n`
            : stderr,
      });
    });
  });
}
