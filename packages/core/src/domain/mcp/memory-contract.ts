// The memory contract every MCP client of the `ocean` server receives (T-296). One source:
// the server sends MEMORY_INSTRUCTIONS in `initialize`, and the memory tools refuse with one of
// MEMORY_ERROR_CODES so a client can recover deterministically instead of parsing messages.

export const MEMORY_CONTRACT_VERSION = 1;

export const MEMORY_INSTRUCTIONS = [
  "Ocean is this user's single memory and environment; do not keep durable facts only in this client's own memory.",
  "Before answering about the user, their projects or past decisions, search with brain_search, read with brain_read or memory_read, and cite the record path.",
  "Use memory_write only when the user explicitly asks you to remember or change something: search first, then mode create for a new record, or mode update with the current sha256 from memory_read as expectedHash.",
  "Facts you infer yourself, and anything imported from another tool's memory, go to memory_propose for the user's review, never to memory_write.",
  "Never store secrets, credentials or temporary state. If a new fact contradicts a record, tell the user instead of overwriting it.",
  "memory_delete is a soft delete; memory_history and memory_restore undo changes.",
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
