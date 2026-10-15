import { spawn } from "node:child_process";
import type {
  InteractiveProcessRequest,
  InteractiveProcessResult,
} from "@ocean/core/domain/process/process-events.js";
import { type IPty, spawn as spawnPty } from "node-pty";

export type {
  InteractiveProcessRequest,
  InteractiveProcessResult,
} from "@ocean/core/domain/process/process-events.js";

export function runInteractive(
  request: InteractiveProcessRequest,
): Promise<InteractiveProcessResult> {
  return new Promise((resolve, reject) => {
    let terminal: IPty;
    try {
      terminal = spawnPty(request.command, request.args, {
        name: process.env.TERM || "xterm-256color",
        cols: process.stdout.columns || 120,
        rows: process.stdout.rows || 40,
        cwd: request.cwd,
        env: { ...process.env, ...request.env } as Record<string, string>,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let output = "";
    let timedOut = false;
    let cancelled = false;
    let timer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const maxCapture = 64_000;
    const onData = (data: string): void => {
      if (output.length < maxCapture)
        output += data.slice(0, maxCapture - output.length);
      process.stdout.write(data);
      request.onData?.(data.slice(0, 64_000));
    };
    terminal.onData(onData);

    const stdinIsTTY = Boolean(process.stdin.isTTY && process.stdin.setRawMode);
    const onStdin = (data: Buffer): void => {
      const input = data.toString();
      request.onInput?.(input);
      terminal.write(input);
    };
    if (stdinIsTTY) {
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      process.stdin.on("data", onStdin);
    }
    const onResize = (): void =>
      terminal.resize(process.stdout.columns || 120, process.stdout.rows || 40);
    process.stdout.on("resize", onResize);

    const stop = (reason: "timeout" | "cancel"): void => {
      if (reason === "timeout") timedOut = true;
      else cancelled = true;
      terminal.kill("SIGTERM");
      forceKillTimer = setTimeout(() => terminal.kill("SIGKILL"), 100);
    };
    const onAbort = (): void => stop("cancel");
    if (request.timeoutMs !== undefined)
      timer = setTimeout(() => stop("timeout"), request.timeoutMs);
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();

    terminal.onExit(({ exitCode }) => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      request.signal?.removeEventListener("abort", onAbort);
      if (stdinIsTTY) {
        process.stdin.off("data", onStdin);
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
      }
      process.stdout.off("resize", onResize);
      resolve({ exitCode, output, timedOut, cancelled });
    });
  });
}

export function runPassthrough(
  request: InteractiveProcessRequest,
): Promise<InteractiveProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: "inherit",
    });
    const timer =
      request.timeoutMs === undefined
        ? undefined
        : setTimeout(() => child.kill("SIGTERM"), request.timeoutMs);
    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (timer) clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: exitCode ?? 1,
        output: "",
        cancelled: request.signal?.aborted,
      });
    });
  });
}
