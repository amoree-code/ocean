import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { oceanPath, SYSTEM_DIR } from "../../paths.js";

export type ConflictSide = "vault" | "ocean";
export function parseConflictSide(value: unknown): ConflictSide | null {
  if (value === "vault") return "vault";
  if (value === "ocean") return "ocean";
  return null;
}
export type ObsidianConflict = {
  version: 1;
  id: string;
  path: string;
  baselineSha256: string | null;
  vaultSha256: string | null;
  oceanSha256: string | null;
  vaultContent?: string;
  oceanContent?: string;
  proposedContent?: string;
  createdAt: string;
  source?: string;
};

function conflictsDirectory(
  root = oceanPath(SYSTEM_DIR, "integrations", "obsidian", "conflicts"),
): string {
  return root;
}

function digest(content: string | undefined | null): string | null {
  return content === undefined || content === null
    ? null
    : createHash("sha256").update(content).digest("hex");
}

export async function appendConflict(
  input: Omit<ObsidianConflict, "version" | "id" | "createdAt">,
  directory = conflictsDirectory(),
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const id = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}`;
  const record: ObsidianConflict = {
    version: 1,
    id,
    ...input,
    createdAt: new Date().toISOString(),
  };
  const file = path.join(directory, `${id}.json`);
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return file;
}

export function readConflictRecord(raw: unknown): ObsidianConflict {
  const record = raw as ObsidianConflict;
  return { ...record, oceanSha256: record.oceanSha256 ?? null };
}

function changedFromBaseline(
  record: ObsidianConflict,
  side: ConflictSide,
): boolean {
  const hash = side === "vault" ? record.vaultSha256 : record.oceanSha256;
  return hash !== record.baselineSha256;
}

export async function resolveConflict(
  id: string,
  requestedKeep: string,
  options: {
    directory?: string;
    apply?: (record: ObsidianConflict, keep: ConflictSide) => Promise<void>;
  } = {},
): Promise<{
  id: string;
  keep: ConflictSide;
  status: "auto-resolved" | "manual-required";
  archived: string;
}> {
  const keep = parseConflictSide(requestedKeep);
  if (!keep) throw new Error("Conflict side must be vault or ocean");
  if (!id || path.basename(id) !== id)
    throw new Error("Conflict id must be a conflict filename");
  const directory = options.directory ?? conflictsDirectory();
  const filename = id.endsWith(".json") ? id : `${id}.json`;
  const source = path.join(directory, filename);
  const record = readConflictRecord(JSON.parse(await readFile(source, "utf8")));
  const vaultChanged = changedFromBaseline(record, "vault");
  const oceanChanged = changedFromBaseline(record, "ocean");
  const status =
    vaultChanged !== oceanChanged ? "auto-resolved" : "manual-required";
  if (status === "auto-resolved" && options.apply)
    await options.apply(record, keep);
  const archiveDirectory = path.join(directory, "resolved");
  await mkdir(archiveDirectory, { recursive: true });
  const archived = path.join(archiveDirectory, id);
  await rename(source, archived);
  return { id: filename, keep, status, archived };
}

export function contentHash(content: string | null | undefined): string | null {
  return digest(content);
}
