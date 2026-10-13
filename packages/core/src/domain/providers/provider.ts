import type { RuntimeEvent } from "../process/process-events.js";

// Pure provider contracts (no behavior) — the set of headless providers and the
// request/adapter shapes. Live in the domain layer; infrastructure/providers
// re-exports them and supplies the concrete adapters and executors.

export type HeadlessProvider =
  | "claude"
  | "codex"
  | "gemini"
  | "antigravity"
  | "hermes"
  | "kilo"
  | "kimi";

export type ProviderRequest = {
  provider: HeadlessProvider;
  prompt: string;
  cwd: string;
  clientHome?: string;
  resumeId?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  onEvent?: (event: RuntimeEvent) => void;
  onSpawn?: (pid: number) => void;
  readOnly?: boolean;
  // The execution plan's model. Absent or "provider-managed" leaves the client's own default.
  model?: string;
  // Child-only variables from the execution plan; never written to this process's env.
  env?: Readonly<Record<string, string>>;
  // Directories outside cwd that the prompt points the provider at (skill folders, context
  // references). Workspace-restricted providers are granted read access to them.
  readDirectories?: string[];
};

export type ProviderAdapter = {
  provider: HeadlessProvider;
  capabilities: readonly string[];
  readOnlyArgs?: readonly string[];
  build: (request: ProviderRequest) => string[];
};

export type ProviderRecord = {
  id: string;
  command: string;
  interactive: boolean;
  headless: boolean;
  // Absent means enabled. A disabled provider's shim execs the real binary untouched.
  enabled?: boolean;
};
