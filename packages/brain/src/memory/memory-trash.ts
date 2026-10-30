import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { MemoryContractError } from "@ocean/core/domain/mcp/memory-contract.js";
import { atomicWrite, withFileLock } from "@ocean/core/shared/fs-utils.js";
import { oceanPath, resolveWithin } from "@ocean/core/shared/paths.js";
import { syncMemoryIndexes } from "./index-sync.js";
import {
  type AuditEntry,
  appendAudit,
  idTime,
  memorySettings,
  newId,
  readAudit,
  sha256,
  writeDurable,
} from "./memory-audit.js";
import {
  permanentRecord,
  storedCopy,
  trashRoot,
  versionsRoot,
} from "./memory-paths.js";
import { checkContent } from "./memory-write.js";

// Soft delete, history, restore and purge (T-296). Nothing over MCP removes content for good:
// a delete moves the record to trash/, an update keeps the old content in versions/, and only
// `ocean memory purge --yes` (CLI) drops copies older than the retention period.

const relativeToWorkspace = (file: string) =>
  path.relative(oceanPath(), file).split(path.sep).join("/");

export async function deleteMemoryRecord(options: {
  path: string;
  expectedHash: string;
  source?: string;
}): Promise<{ path: string; auditId: string; trash: string }> {
  const record = permanentRecord(options.path);
  const id = newId();
  const { before, trash } = await withFileLock(record.file, async () => {
    let current: string;
    try {
      current = await readFile(record.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new MemoryContractError(
          "MISSING",
          `${record.relative} not found`,
        );
      throw error;
    }
    if (options.expectedHash !== sha256(current))
      throw new MemoryContractError(
        "CONFLICT",
        "expectedHash does not match the record; read it again before deleting",
        { sha256: sha256(current) },
      );
    const stored = storedCopy("trash", id, record.relative);
    await writeDurable(stored, current);
    await rm(record.file);
    return { before: current, trash: relativeToWorkspace(stored) };
  });
  await appendAudit({
    id,
    action: "delete",
    path: record.relative,
    source: options.source ?? "unknown",
    beforeSha: sha256(before),
    afterSha: null,
    copy: trash,
  });
  if (record.personal) await syncMemoryIndexes(true);
  return { path: record.relative, auditId: id, trash };
}

export async function memoryHistory(
  options: { path?: string; limit?: number } = {},
): Promise<{ entries: AuditEntry[] }> {
  const wanted = options.path?.split("\\").join("/");
  const entries = (await readAudit()).filter(
    (entry) => !wanted || entry.path === wanted,
  );
  const limit = Math.min(100, Math.max(1, options.limit ?? 20));
  return { entries: entries.slice(-limit).reverse() };
}

// Puts back the content an audit entry preserved: a deleted record (only while its path is
// free) or an earlier version (the current content is versioned first, and the caller must
// name it by hash, as for an update).
export async function restoreMemory(options: {
  id: string;
  expectedHash?: string;
  source?: string;
}): Promise<{ path: string; auditId: string; sha256: string }> {
  const entry = (await readAudit()).find(
    (item) => item.id === options.id && item.copy,
  );
  if (!entry?.copy)
    throw new MemoryContractError(
      "MISSING",
      `no stored copy for audit entry ${options.id}`,
    );
  const copyFile = resolveCopy(entry.copy);
  let content: string;
  try {
    content = await readFile(copyFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new MemoryContractError(
        "MISSING",
        `stored copy ${entry.copy} was purged`,
      );
    throw error;
  }
  checkContent(content);
  const record = permanentRecord(entry.path);
  const id = newId();
  const replaced = await withFileLock(record.file, async () => {
    let current: string | null = null;
    try {
      current = await readFile(record.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let copy: string | undefined;
    if (current !== null) {
      if (entry.action === "delete")
        throw new MemoryContractError(
          "EXISTS",
          `${record.relative} was recreated after the delete; restore an earlier version instead`,
        );
      if (options.expectedHash !== sha256(current))
        throw new MemoryContractError(
          "CONFLICT",
          "expectedHash does not match the record; read it again before restoring",
          { sha256: sha256(current) },
        );
      const stored = storedCopy("versions", id, record.relative);
      await writeDurable(stored, current);
      copy = relativeToWorkspace(stored);
    }
    await atomicWrite(record.file, content);
    return { before: current, copy };
  });
  await appendAudit({
    id,
    action: "restore",
    path: record.relative,
    source: options.source ?? "unknown",
    beforeSha: replaced.before === null ? null : sha256(replaced.before),
    afterSha: sha256(content),
    copy: replaced.copy,
    restoredFrom: entry.id,
  });
  if (record.personal) await syncMemoryIndexes(true);
  return { path: record.relative, auditId: id, sha256: sha256(content) };
}

// An audit entry's copy must still name a file under versions/ or trash/.
function resolveCopy(copy: string): string {
  const file = oceanPath(...copy.split("/"));
  for (const root of [versionsRoot(), trashRoot()]) {
    try {
      return resolveWithin(root, path.relative(root, file));
    } catch {}
  }
  throw new MemoryContractError(
    "OUT_OF_ROOT",
    `stored copy ${copy} is outside versions/ and trash/`,
  );
}

// CLI only. Lists stored copies older than the retention period; removes them only with apply.
export async function purgeMemoryCopies(options: {
  apply: boolean;
  days?: number;
  now?: Date;
}): Promise<{ cutoff: string; copies: string[]; applied: boolean }> {
  const days = options.days ?? (await memorySettings()).retentionDays;
  if (!Number.isInteger(days) || days < 1)
    throw new MemoryContractError("INVALID", "days must be a whole number ≥ 1");
  const cutoff = new Date(
    (options.now ?? new Date()).getTime() - days * 86_400_000,
  );
  const copies: string[] = [];
  for (const root of [versionsRoot(), trashRoot()]) {
    const ids = await readdir(root).catch(() => [] as string[]);
    for (const id of ids.sort()) {
      const time = idTime(id);
      if (time && time < cutoff)
        copies.push(relativeToWorkspace(path.join(root, id)));
    }
  }
  if (options.apply)
    for (const copy of copies) {
      await rm(oceanPath(...copy.split("/")), { recursive: true, force: true });
      await appendAudit({
        action: "purge",
        path: copy,
        source: "cli",
        beforeSha: null,
        afterSha: null,
      });
    }
  return { cutoff: cutoff.toISOString(), copies, applied: options.apply };
}
