// Pure process I/O contracts. These are the shapes exchanged with a headless
// child process; they carry no behavior, so they live in the domain layer and
// infrastructure/process/cli-process.ts re-exports them.

export type RuntimeEvent = {
  type: "json" | "text";
  data: unknown;
};

export type HeadlessRequest = {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  onEvent?: (event: RuntimeEvent) => void;
  onSpawn?: (pid: number) => void;
};

export type HeadlessResult = {
  exitCode: number;
  events: RuntimeEvent[];
  stderr: string;
};

export type InteractiveProcessRequest = {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  onData?: (data: string) => void;
  onInput?: (data: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type InteractiveProcessResult = {
  exitCode: number;
  output: string;
  timedOut?: boolean;
  cancelled?: boolean;
};
