import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

// The one place that decides how a headless run ends, for every provider that runs a process: the
// run's timeout (124), its output budget (125), the process group it runs in, the signals passed
// on to it, and how stdout becomes lines. `runHeadless` (CLI providers) and the Claude Agent SDK
// runner both use it, so a fix to any of these lands once.

// A process run in its own group is stopped as a whole, so a timeout or budget stop ends
// everything it started (a tool's subprocess too), not just the leader: a surviving descendant
// would hold the output pipe open and keep the run waiting.
export const ownsGroup = process.platform !== "win32";
const forwardedSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

// How long output still in the pipe gets, once the process itself has exited, before whatever
// else holds the pipe open (a background process it left behind) is stopped and no longer awaited.
const LINGER_MS = 500;

export function signalTree(
  child: ChildProcess | undefined,
  signal: NodeJS.Signals,
): void {
  if (!child?.pid) return;
  try {
    if (ownsGroup) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // Already gone.
  }
}

// Out of the terminal's process group, a run no longer receives this process's Ctrl+C or kill
// directly; pass them on, then let the signal do what it would have done here. One set of
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

export type SupervisorOptions = {
  timeoutMs: number;
  maxOutputBytes: number;
  // Each complete stdout line, in order; the last unterminated line comes from `flush`.
  onLine?: (line: string) => void;
  // A stop has begun (timeout or budget): the caller's own way to cancel, e.g. an abort signal.
  onTerminate?: () => void;
};

export type Supervision = {
  // Watch a spawned process. It should be spawned `detached: ownsGroup`.
  attach(child: ChildProcess): void;
  // Settles when the process has closed: its output is complete.
  readonly closed: Promise<void>;
  // Settles only when the run is let go early: stopped by a timeout or the output budget, failed
  // to start, or left holding its pipes after it exited. Output may then be incomplete.
  readonly released: Promise<void>;
  readonly spawnError: Error | undefined;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;
  // Raw stderr, within the budget.
  readonly stderr: string;
  // "Process timed out.\n", "Output budget exceeded.\n", or "" when neither stop happened.
  readonly stopNote: string;
  // The exit code the contract reports: 124 and 125 for the stops, 1 for no exit code (killed
  // by a signal, never started), else the process's own.
  exitCode(code: number | null | undefined): number;
  // The last unterminated stdout line.
  flush(): void;
  // The process is gone: stop the timers, end anything it left in its group, stop watching it.
  finish(): void;
};

export function superviseProcess(options: SupervisorOptions): Supervision {
  let child: ChildProcess | undefined;
  let release = () => {};
  let spawnError: Error | undefined;
  let stderr = "";
  let outputBytes = 0;
  let timedOut = false;
  let outputLimitExceeded = false;
  let terminating = false;
  let killTimer: NodeJS.Timeout | undefined;
  let lingerTimer: NodeJS.Timeout | undefined;
  let letGoNow = () => {};
  const released = new Promise<void>((resolve) => {
    letGoNow = resolve;
  });
  let closedNow = () => {};
  const closed = new Promise<void>((resolve) => {
    closedNow = resolve;
  });

  // Whatever still holds the pipes (a descendant that left the group) no longer holds the run.
  const letGo = (): void => {
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    letGoNow();
  };

  const terminate = (): void => {
    if (terminating) return;
    terminating = true;
    options.onTerminate?.();
    signalTree(child, "SIGTERM");
    // Not unref'd: this timer keeps the process alive until the run has been let go.
    killTimer = setTimeout(() => {
      signalTree(child, "SIGKILL");
      letGo();
    }, 100);
  };

  // Armed until the process has closed, not just until the output stops.
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.timeoutMs);

  // Raw stdout and stderr bytes count against one budget as they arrive, before anything buffers
  // a line, so a huge or unterminated line cannot grow past the cap.
  const withinBudget = (bytes: number): boolean => {
    if (outputLimitExceeded) return false;
    if (outputBytes + bytes > options.maxOutputBytes) {
      outputLimitExceeded = true;
      terminate();
      return false;
    }
    outputBytes += bytes;
    return true;
  };

  const decoder = new StringDecoder("utf8");
  let pending = "";
  const emit = (line: string): void => {
    if (line) options.onLine?.(line);
  };

  return {
    attach(spawned) {
      child = spawned;
      if (ownsGroup) release = endWithThisProcess(spawned);
      // A failed start (no such executable) is a failed run; the abort of a stop we asked for is not.
      spawned.once("error", (error) => {
        if (terminating) return;
        spawnError = error;
        letGo();
      });
      spawned.once("exit", () => {
        if (!terminating) lingerTimer = setTimeout(letGo, LINGER_MS);
      });
      spawned.once("close", closedNow);
      spawned.stdout?.on("data", (chunk: Buffer) => {
        if (!withinBudget(chunk.byteLength)) return;
        pending += decoder.write(chunk);
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) emit(line);
      });
      spawned.stderr?.on("data", (chunk: Buffer) => {
        if (withinBudget(chunk.byteLength)) stderr += chunk.toString("utf8");
      });
    },
    closed,
    released,
    get spawnError() {
      return spawnError;
    },
    get timedOut() {
      return timedOut;
    },
    get outputLimitExceeded() {
      return outputLimitExceeded;
    },
    get stderr() {
      return stderr;
    },
    get stopNote() {
      return timedOut
        ? "Process timed out.\n"
        : outputLimitExceeded
          ? "Output budget exceeded.\n"
          : "";
    },
    exitCode(code) {
      return timedOut ? 124 : outputLimitExceeded ? 125 : (code ?? 1);
    },
    flush() {
      emit(pending + decoder.end());
      pending = "";
    },
    finish() {
      clearTimeout(timer);
      clearTimeout(lingerTimer);
      clearTimeout(killTimer);
      // The leader is gone; end anything it left in the group, then stop watching it.
      signalTree(child, "SIGKILL");
      release();
    },
  };
}
