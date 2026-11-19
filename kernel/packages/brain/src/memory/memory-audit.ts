import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, withFileLock } from "@ocean/core/shared/fs-utils.js";
import { oceanEnv, oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
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
  // The session the change was made in, when the client exposes one (T-319).
  session?: string;
  origin?: "explicit" | "inferred" | "imported";
  // The review candidate an approved record came from.
  candidate?: string;
  beforeSha: string | null;
  afterSha: string | null;
  // Workspace-relative stored copy of the content the action replaced or removed.
  copy?: string;
  restoredFrom?: string;
};

export type MemorySettings = {
  mcpWrites: boolean;
  retentionDays: number;
  // `ocean pull` approves what it proposes as new records (T-305); off by default, for review.
  pullAutoApprove: boolean;
  // A client's proposal filed to an existing project's memory or docs is written at once as a
  // new file (T-307); off by default, for review.
  proposeAutoApprove: boolean;
  // Facts captured from session transcripts by a model call (T-313): asked once at
  // `ocean client apply`; null until the owner answers, which means off.
  sessionFacts: boolean | null;
};

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

// The session this process runs in: OCEAN_SESSION_ID (any client, or Ocean itself), else the
// id Claude Code gives its tools and MCP servers, which is also Ocean's id for that session.
// Anything that is not a plain id is ignored rather than written to the log.
export function currentSession(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const id = oceanEnv("SESSION_ID", env) || env.CLAUDE_CODE_SESSION_ID;
  return id && /^[\w.:-]{1,128}$/.test(id) ? id : undefined;
}

export async function appendAudit(
  entry: Omit<AuditEntry, "id" | "ts"> & { id?: string },
): Promise<AuditEntry> {
  const session = entry.session ?? currentSession();
  const full: AuditEntry = {
    ...entry,
    ...(session ? { session } : {}),
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

// Who wrote, changed or deleted what (T-319): the client is the source up to its first colon
// (`session:<id>` is the session-facts capture), counted per action, newest entries first.
export type AuditSummary = {
  since: string | null;
  total: number;
  unknown: number;
  clients: { client: string; total: number; actions: Record<string, number> }[];
  entries: AuditEntry[];
};

export function auditClient(entry: AuditEntry): string {
  return entry.source.split(":")[0] || "unknown";
}

export async function auditSummary(
  options: { client?: string; days?: number; limit?: number; now?: Date } = {},
): Promise<AuditSummary> {
  const now = options.now ?? new Date();
  const since =
    options.days === undefined
      ? null
      : new Date(now.getTime() - options.days * 86_400_000);
  const entries = (await readAudit()).filter(
    (entry) =>
      (!since || new Date(entry.ts) >= since) &&
      (!options.client ||
        auditClient(entry) === options.client ||
        entry.source === options.client),
  );
  const clients = new Map<string, AuditSummary["clients"][number]>();
  for (const entry of entries) {
    const name = auditClient(entry);
    const row = clients.get(name) ?? { client: name, total: 0, actions: {} };
    row.total += 1;
    row.actions[entry.action] = (row.actions[entry.action] ?? 0) + 1;
    clients.set(name, row);
  }
  const limit = Math.max(0, options.limit ?? 20);
  return {
    since: since?.toISOString() ?? null,
    total: entries.length,
    unknown: entries.filter((entry) => auditClient(entry) === "unknown").length,
    clients: [...clients.values()].sort(
      (a, b) => b.total - a.total || a.client.localeCompare(b.client),
    ),
    entries: limit ? entries.slice(-limit).reverse() : [],
  };
}

// bridge/config/memory.json — optional; without it MCP writes are on, copies are kept 90 days and
// pulled memory waits for review.
export async function memorySettings(): Promise<MemorySettings> {
  const file = memorySettingsFile();
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        mcpWrites: true,
        retentionDays: DEFAULT_RETENTION_DAYS,
        pullAutoApprove: false,
        proposeAutoApprove: false,
        sessionFacts: null,
      };
    throw new Error(`Invalid memory settings in ${file}`);
  }
  const writes = input.mcpWrites ?? "on";
  const days = input.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const pullApprove = input.pullAutoApprove ?? "off";
  const proposeApprove = input.proposeAutoApprove ?? "off";
  const sessionFacts = input.sessionFacts;
  if (
    sessionFacts !== undefined &&
    sessionFacts !== "on" &&
    sessionFacts !== "off"
  )
    throw new Error(`Invalid memory settings in ${file}`);
  if (
    (writes !== "on" && writes !== "off") ||
    (pullApprove !== "on" && pullApprove !== "off") ||
    (proposeApprove !== "project" && proposeApprove !== "off") ||
    typeof days !== "number" ||
    !Number.isInteger(days) ||
    days < 1
  )
    throw new Error(`Invalid memory settings in ${file}`);
  return {
    mcpWrites: writes === "on",
    retentionDays: days,
    pullAutoApprove: pullApprove === "on",
    proposeAutoApprove: proposeApprove === "project",
    sessionFacts: sessionFacts === undefined ? null : sessionFacts === "on",
  };
}

function memorySettingsFile(): string {
  return oceanPath(SYSTEM_DIR, "config", "memory.json");
}

// The owner's answer to the session-facts question; every other setting is kept as it is.
export async function setSessionFacts(on: boolean): Promise<void> {
  const file = memorySettingsFile();
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(`Invalid memory settings in ${file}`);
  }
  input.sessionFacts = on ? "on" : "off";
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWrite(file, `${JSON.stringify(input, null, 2)}\n`, 0o600);
}

// Whether a finished session's facts are captured: OCEAN_SESSION_FACTS=on|off overrides the
// owner's saved answer; no answer is off.
export async function sessionFactsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const override = oceanEnv("SESSION_FACTS", env);
  if (override === "on") return true;
  if (override === "off") return false;
  return (await memorySettings()).sessionFacts === true;
}
