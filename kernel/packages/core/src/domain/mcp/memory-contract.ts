// The memory contract every MCP client of the `ocean` server receives (T-296). One source:
// the server sends MEMORY_INSTRUCTIONS in `initialize`, and the memory tools refuse with one of
// MEMORY_ERROR_CODES so a client can recover deterministically instead of parsing messages.

export const MEMORY_CONTRACT_VERSION = 1;

export const MEMORY_INSTRUCTIONS = [
  "Ocean is this user's single memory and environment; do not keep durable facts only in this client's own memory.",
  // Only Ocean's server sends this text, so it is true wherever it is read. A record listing
  // clients that cannot connect is not about this session (T-307: Desktop chat misread it).
  "If you can call these tools, this client is connected to Ocean.",
  // Relevance triggers (T-328 P2): concrete cues, not "about the user", which a model reads
  // narrowly and so skips Ocean on most turns (Desktop chat went 10 days without a call).
  "Call brain_search before you answer whenever a message touches the user's own world: their projects, code, tasks, people, past decisions or preferences, or words like my, our, last time, as before; and before planning, writing or reviewing anything for them. Read hits with brain_read and cite the path.",
  "When the user states a decision, preference or correction, call memory_propose. Use memory_write only when they ask you to remember or change something: search first, then create, or update with memory_read's sha256 as expectedHash.",
  "Never store secrets or temporary state; if a fact contradicts a record, tell the user. memory_delete is soft; memory_history and memory_restore undo.",
  // The handoff rule lives in ocean_handoff_create's own description; the ack line is T-319.
  "Without a session-start hook, call ocean_context once. Pass the start line's ack=<hash> as contextAck on your first Ocean call.",
].join(" ");

export const MEMORY_ERROR_CODES = [
  "EXISTS",
  "EXISTS_SIMILAR",
  "MISSING",
  "OUT_OF_ROOT",
  "PROTECTED",
  "SYMLINK",
  "HARDLINK",
  "SECRET",
  "CONFLICT",
  "TOO_LARGE",
  "INVALID",
  "WRITES_OFF",
] as const;

export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number];

export class MemoryContractError extends Error {
  readonly code: MemoryErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: MemoryErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "MemoryContractError";
    this.code = code;
    this.details = details;
  }
}
