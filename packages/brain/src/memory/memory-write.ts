import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { MemoryContractError } from "@ocean/core/domain/mcp/memory-contract.js";
import { containsKnownSecret } from "@ocean/core/domain/redaction/redaction.js";
import { atomicWrite, withFileLock } from "@ocean/core/shared/fs-utils.js";
import { localDate } from "@ocean/core/shared/local-date.js";
import {
  oceanPath,
  PERSONAL_DIR,
  PROJECTS_DIR,
} from "@ocean/core/shared/paths.js";
import { syncMemoryIndexes } from "./index-sync.js";
import { appendAudit, newId, sha256, writeDurable } from "./memory-audit.js";
import {
  assertNoLinks,
  candidateFile,
  candidatesRoot,
  permanentRecord,
  storedCopy,
} from "./memory-paths.js";

const maxRecordBytes = 32_000;

export type MemoryWriteMode = "create" | "update";

export function checkContent(content: string): void {
  if (typeof content !== "string" || !content.trim())
    throw new MemoryContractError("INVALID", "content is empty");
  if (Buffer.byteLength(content) > maxRecordBytes)
    throw new MemoryContractError(
      "TOO_LARGE",
      `content exceeds ${maxRecordBytes} bytes`,
    );
  if (containsKnownSecret(content))
    throw new MemoryContractError(
      "SECRET",
      "content holds a secret; memory never stores one",
    );
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function withNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

export async function readMemoryRecord(
  relative: string,
): Promise<{ path: string; content: string; sha256: string }> {
  const record = permanentRecord(relative);
  const content = await readIfPresent(record.file);
  if (content === null)
    throw new MemoryContractError("MISSING", `${record.relative} not found`);
  return { path: record.relative, content, sha256: sha256(content) };
}

async function markdownFiles(directory: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(full)));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function title(content: string): string {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(content)?.[1] ?? "";
  return (
    /^(?:name|title):\s*["']?(.+?)["']?\s*$/m.exec(frontmatter)?.[1] ??
    /^#\s+(.+)$/m.exec(content)?.[1] ??
    ""
  );
}

// A new record whose file name or title matches an existing one is probably the same fact:
// the caller must update that record, or say it is a different one (allowSimilar).
async function similarRecords(
  file: string,
  content: string,
): Promise<string[]> {
  const projects = await readdir(oceanPath(PROJECTS_DIR), {
    withFileTypes: true,
  }).catch(() => []);
  const roots = [
    oceanPath(PERSONAL_DIR),
    ...projects
      .filter((entry) => entry.isDirectory())
      .map((entry) => oceanPath(PROJECTS_DIR, entry.name, "memory")),
  ];
  const name = normalize(path.basename(file));
  const heading = normalize(title(content));
  const matches: string[] = [];
  for (const root of roots)
    for (const existing of await markdownFiles(root)) {
      // The target itself is not "similar": an exact existing path is EXISTS.
      if (
        existing === file ||
        path.basename(existing).toLowerCase() === "memory.md"
      )
        continue;
      const sameName = normalize(path.basename(existing)) === name;
      const sameTitle =
        heading !== "" &&
        normalize(title(await readFile(existing, "utf8"))) === heading;
      if (sameName || sameTitle)
        matches.push(
          path.relative(oceanPath(), existing).split(path.sep).join("/"),
        );
    }
  return matches;
}

// An explicit save. Search-first is enforced by mode: `create` refuses an existing or similar
// record, `update` needs the sha256 the caller read, so a stale or blind write cannot clobber.
// The replaced content is kept in versions/ before the record changes.
export async function writeMemoryRecord(options: {
  path: string;
  content: string;
  mode: MemoryWriteMode;
  expectedHash?: string;
  allowSimilar?: boolean;
  source?: string;
}): Promise<{
  path: string;
  mode: MemoryWriteMode;
  sha256: string;
  auditId: string;
  indexed: boolean;
}> {
  const record = permanentRecord(options.path);
  checkContent(options.content);
  if (options.mode !== "create" && options.mode !== "update")
    throw new MemoryContractError("INVALID", "mode must be create or update");
  if (options.mode === "create" && !options.allowSimilar) {
    const similar = await similarRecords(record.file, options.content);
    if (similar.length)
      throw new MemoryContractError(
        "EXISTS_SIMILAR",
        "a record with the same name or title exists; update it, or pass allowSimilar if this is a different fact",
        { paths: similar },
      );
  }
  const content = withNewline(options.content);
  const id = newId();
  await mkdir(path.dirname(record.file), { recursive: true });
  assertNoLinks(record.root, record.file);
  const { before, copy } = await withFileLock(record.file, async () => {
    const current = await readIfPresent(record.file);
    if (options.mode === "create" && current !== null)
      throw new MemoryContractError(
        "EXISTS",
        "record already exists; read it and write it back with mode update",
      );
    if (options.mode === "update") {
      if (current === null)
        throw new MemoryContractError(
          "MISSING",
          "record does not exist; use mode create",
        );
      if (options.expectedHash !== sha256(current))
        throw new MemoryContractError(
          "CONFLICT",
          "expectedHash does not match the record; read it again before updating",
          { sha256: sha256(current) },
        );
    }
    let copy: string | undefined;
    if (current !== null) {
      const stored = storedCopy("versions", id, record.relative);
      await writeDurable(stored, current);
      copy = path.relative(oceanPath(), stored).split(path.sep).join("/");
    }
    await atomicWrite(record.file, content);
    return { before: current, copy };
  });
  await appendAudit({
    id,
    action: options.mode,
    path: record.relative,
    source: options.source ?? "unknown",
    origin: "explicit",
    beforeSha: before === null ? null : sha256(before),
    afterSha: sha256(content),
    copy,
  });
  if (record.personal) await syncMemoryIndexes(true);
  return {
    path: record.relative,
    mode: options.mode,
    sha256: sha256(content),
    auditId: id,
    indexed: record.personal,
  };
}

const singleLine = (value: string | undefined, field: string) => {
  if (value === undefined) return "";
  if (typeof value !== "string" || /[\r\n]/.test(value) || value.length > 200)
    throw new MemoryContractError(
      "INVALID",
      `${field} must be one line of at most 200 characters`,
    );
  return value;
};

// Where a candidate came from, for the owner to sort by (T-305: client, project, file, date).
// Internal callers only; never taken from an MCP client.
export type CandidateMeta = Record<string, string | boolean | string[]>;
const RESERVED = new Set([
  "candidate",
  "origin",
  "source",
  "target",
  "reason",
  "created",
]);

function metaLines(meta: CandidateMeta | undefined): string {
  let lines = "";
  for (const [key, value] of Object.entries(meta ?? {})) {
    const rendered = JSON.stringify(value);
    if (
      !/^[a-z][a-z_]{0,30}$/.test(key) ||
      RESERVED.has(key) ||
      rendered.length > 600
    )
      throw new MemoryContractError("INVALID", `bad candidate field '${key}'`);
    lines += `${key}: ${rendered}\n`;
  }
  return lines;
}

// An inferred or imported fact waits in candidates/ for the owner's review. The server names
// the file; a proposed target is validated as a record path but never written here.
export async function proposeMemory(options: {
  content: string;
  origin: "inferred" | "imported";
  target?: string;
  reason?: string;
  source?: string;
  meta?: CandidateMeta;
}): Promise<{ candidate: string; auditId: string }> {
  checkContent(options.content);
  const extra = metaLines(options.meta);
  if (options.origin !== "inferred" && options.origin !== "imported")
    throw new MemoryContractError(
      "INVALID",
      "origin must be inferred or imported",
    );
  const target = options.target ? permanentRecord(options.target).relative : "";
  const reason = singleLine(options.reason, "reason");
  const source = singleLine(options.source, "source") || "unknown";
  const id = newId();
  const file = candidateFile(localDate(), id);
  assertNoLinks(candidatesRoot(), file);
  const body = `---\ncandidate: ${id}\norigin: ${options.origin}\nsource: ${JSON.stringify(source)}\ntarget: ${JSON.stringify(target)}\nreason: ${JSON.stringify(reason)}\ncreated: ${new Date().toISOString()}\n${extra}---\n\n${withNewline(options.content)}`;
  await writeDurable(file, body);
  const candidate = path.relative(oceanPath(), file).split(path.sep).join("/");
  await appendAudit({
    id,
    action: "propose",
    path: candidate,
    source,
    origin: options.origin,
    beforeSha: null,
    afterSha: sha256(body),
  });
  return { candidate, auditId: id };
}
