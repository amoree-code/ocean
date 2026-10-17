import { spawn } from "node:child_process";
import type {
  HeadlessRequest,
  HeadlessResult,
  RuntimeEvent,
} from "@ocean/core/domain/process/process-events.js";
import { ownsGroup, superviseProcess } from "./process-supervisor.js";

// Process contracts live in the domain layer; re-exported here for existing callers.
export type {
  HeadlessRequest,
  HeadlessResult,
} from "@ocean/core/domain/process/process-events.js";

// Applied whenever a caller doesn't pass an explicit maxOutputBytes, so a headless run
// without a budget contract can never buffer unbounded output (disk/memory exhaustion,
// unbounded secret/log capture surface).
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export async function runHeadless(
  request: HeadlessRequest,
): Promise<HeadlessResult> {
  const events: RuntimeEvent[] = [];
  const supervision = superviseProcess({
    timeoutMs: request.timeoutMs ?? 60_000,
    maxOutputBytes: request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    onLine: (line) => {
      let event: RuntimeEvent;
      try {
        event = { type: "json", data: JSON.parse(line) };
      } catch {
        event = { type: "text", data: line };
      }
      events.push(event);
      request.onEvent?.(event);
    },
  });
  try {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: ownsGroup,
      windowsHide: true,
    });
    supervision.attach(child);
    if (child.pid) request.onSpawn?.(child.pid);
    await Promise.race([supervision.closed, supervision.released]);
    if (supervision.spawnError && !supervision.timedOut)
      throw supervision.spawnError;
    supervision.flush();
    return {
      exitCode: supervision.exitCode(child.exitCode),
      events,
      stderr: supervision.stderr + supervision.stopNote,
    };
  } finally {
    supervision.finish();
  }
}
