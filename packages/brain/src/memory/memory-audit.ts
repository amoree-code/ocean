import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "@ocean/core/shared/fs-utils.js";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { auditFile } from "./memory-paths.js";

// The memory audit log and the memory settings (T-296). Every mutation appends one line, so
// history and restore read from one place; the log holds hashes and paths, never content.

export type MemoryAction =
  | "create"
  | "update"
  | "propose"
  | "delete"
  | "restore"
  | "purge"
  // Candidate review (T-296 P5): the candidate moved to trash after approve or reject.
  | "approve"
  | "reject";

export type AuditEntry = {
  id: string;
  ts: string;
  action: MemoryAction;
  path: string;
  source: string;
  origin?: "explicit" | "inferred" | "imported";
  beforeSha: string | null;
  afterSha: string | null;
  // Workspace-relative stored copy of the content the action replaced or removed.
  copy?: string;
  restoredFrom?: string;
};

export type MemorySettings = { mcpWrites: boolean; retentionDays: number };

export const DEFAULT_RETENTION_DAYS = 90;

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// Sortable by time, unique enough for one workspace: 20261030161550-1a2b3c4d.
export function newId(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:TZ]/g, "")
    .slice(0, 14);
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

export function idTime(id: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-/.exec(id);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
}

// A stored copy is written once and fsynced before the record it preserves is replaced.
export async function writeDurable(
  file: string,
  content: string,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function appendAudit(
  entry: Omit<AuditEntry, "id" | "ts"> & { id?: string },
): Promise<AuditEntry> {
  const full: AuditEntry = {
    ...entry,
    id: entry.id ?? newId(),
    ts: new Date().toISOString(),
  };
  const file = auditFile();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await withFileLock(file, () =>
    appendFile(file, `${JSON.stringify(full)}\n`, { mode: 0o600 }),
  );
  return full;
}

export async function readAudit(): Promise<AuditEntry[]> {
  let text: string;
  try {
    text = await readFile(auditFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditEntry);
}

// bridge/config/memory.json — optional; without it MCP writes are on and copies are kept 90 days.
export async function memorySettings(): Promise<MemorySettings> {
  const file = oceanPath(SYSTEM_DIR, "config", "memory.json");
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { mcpWrites: true, retentionDays: DEFAULT_RETENTION_DAYS };
    throw new Error(`Invalid memory settings in ${file}`);
  }
  const writes = input.mcpWrites ?? "on";
  const days = input.retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (
    (writes !== "on" && writes !== "off") ||
    typeof days !== "number" ||
    !Number.isInteger(days) ||
    days < 1
  )
    throw new Error(`Invalid memory settings in ${file}`);
  return { mcpWrites: writes === "on", retentionDays: days };
}
