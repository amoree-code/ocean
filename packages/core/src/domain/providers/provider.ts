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

// A text completion over an OpenAI-compatible HTTP API (T-245 Phase 4). The endpoint and the
// credential's environment-variable name are fixed per provider by the transport; a request
// can name neither.
export type CompletionProvider = "deepseek" | "openrouter";

export type CompletionRequest = {
  provider: CompletionProvider;
  model: string;
  prompt: string;
  temperature?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
  // Total attempts, including the first; only 429 and 5xx responses are retried.
  maxAttempts?: number;
  onEvent?: (event: RuntimeEvent) => void;
};

// One turn of a tool-loop conversation, in the OpenAI-compatible shape (T-245 Phase 6).
export type ChatToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ChatRequest = {
  provider: CompletionProvider;
  model: string;
  temperature?: number;
  messages: ChatMessage[];
  tools: object[];
  maxOutputBytes?: number;
  maxAttempts?: number;
  // The caller's deadline and cancellation; the transport adds none of its own.
  signal: AbortSignal;
  onEvent?: (event: RuntimeEvent) => void;
};

export type ChatReply = {
  message: Extract<ChatMessage, { role: "assistant" }>;
  model: string;
  usage: unknown;
  id: string | null;
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
