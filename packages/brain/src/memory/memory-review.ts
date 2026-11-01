import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { MemoryContractError } from "@ocean/core/domain/mcp/memory-contract.js";
import { oceanPath } from "@ocean/core/shared/paths.js";
import { appendAudit, newId, sha256 } from "./memory-audit.js";
import { candidatesRoot, storedCopy } from "./memory-paths.js";
import { readMemoryRecord, writeMemoryRecord } from "./memory-write.js";

// Owner review of proposed memory (T-296 §3.10): every approval goes through the same validated
// write path as an explicit save (roots, secrets, similarity), and a reviewed candidate is moved
// to trash — never deleted — with an audit entry, so a wrong decision can be traced and undone.

export type Candidate = {
  id: string;
  file: string;
  day: string;
  origin: string;
  source: string;
  target: string;
  reason: string;
  created: string;
  // Any other frontmatter field, as written: where `ocean pull` says the candidate came from.
  meta: Record<string, unknown>;
  content: string;
};

function parse(text: string): Omit<Candidate, "id" | "file" | "day"> | null {
  const match = /^---\n([\s\S]*?)\n---\n\n?/.exec(text);
  if (!match) return null;
  const fields: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const index = line.indexOf(":");
    if (index < 0) continue;
    const raw = line.slice(index + 1).trim();
    let value: unknown = raw;
    try {
      value =
        /^["[]/.test(raw) || raw === "true" || raw === "false"
          ? JSON.parse(raw)
          : raw;
    } catch {
      // a hand-edited value stays as written
    }
    fields[line.slice(0, index).trim()] = value;
  }
  const known = [
    "candidate",
    "origin",
    "source",
    "target",
    "reason",
    "created",
  ];
  const field = (key: string) =>
    typeof fields[key] === "string" ? (fields[key] as string) : "";
  return {
    origin: field("origin"),
    source: field("source"),
    target: field("target"),
    reason: field("reason"),
    created: field("created"),
    meta: Object.fromEntries(
      Object.entries(fields).filter(([key]) => !known.includes(key)),
    ),
    content: text.slice(match[0].length),
  };
}

export async function listCandidates(): Promise<Candidate[]> {
  const root = candidatesRoot();
  const found: Candidate[] = [];
  const days = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const day of days.filter((entry) => entry.isDirectory()).sort()) {
    for (const name of (await readdir(path.join(root, day.name))).sort()) {
      if (!name.endsWith(".md")) continue;
      const file = path.join(root, day.name, name);
      const parsed = parse(await readFile(file, "utf8"));
      if (!parsed) continue;
      found.push({
        id: name.slice(0, -3),
        file: path.relative(oceanPath(), file).split(path.sep).join("/"),
        day: day.name,
        ...parsed,
      });
    }
  }
  return found;
}

async function candidate(id: string): Promise<Candidate> {
  const found = (await listCandidates()).find((item) => item.id === id);
  if (!found)
    throw new MemoryContractError("MISSING", `no candidate '${id}' to review`);
  return found;
}

async function retire(
  item: Candidate,
  action: "approve" | "reject",
  source = "owner-review",
): Promise<string> {
  const id = newId();
  const copy = storedCopy("trash", id, item.file);
  await mkdir(path.dirname(copy), { recursive: true, mode: 0o700 });
  const text = await readFile(oceanPath(item.file), "utf8");
  await rename(oceanPath(item.file), copy);
  await appendAudit({
    id,
    action,
    path: item.file,
    source,
    origin: item.origin === "imported" ? "imported" : "inferred",
    beforeSha: sha256(text),
    afterSha: null,
    copy: path.relative(oceanPath(), copy).split(path.sep).join("/"),
  });
  return id;
}

// Writes the candidate's content to `to` (default: its proposed target). A new record is
// created; an existing one gets the content appended, guarded by its current hash — unless
// `createOnly` (an approval nobody looked at), which leaves that one to the owner's review.
export async function approveCandidate(options: {
  id: string;
  to?: string;
  createOnly?: boolean;
  source?: string;
}): Promise<{ path: string; mode: "create" | "update"; auditId: string }> {
  const source = options.source ?? "owner-review";
  const item = await candidate(options.id);
  const target = options.to ?? item.target;
  if (!target)
    throw new MemoryContractError(
      "INVALID",
      "the candidate names no target; pass --to <record path>",
    );
  const existing = await readMemoryRecord(target).catch((error: unknown) => {
    if (error instanceof MemoryContractError && error.code === "MISSING")
      return null;
    throw error;
  });
  if (existing && options.createOnly)
    throw new MemoryContractError(
      "CONFLICT",
      `${target} exists; adding to it needs review`,
    );
  const written = existing
    ? await writeMemoryRecord({
        path: target,
        content: `${existing.content.replace(/\n*$/, "\n\n")}${item.content}`,
        mode: "update",
        expectedHash: existing.sha256,
        source,
      })
    : await writeMemoryRecord({
        path: target,
        content: item.content,
        mode: "create",
        source,
      });
  await retire(item, "approve", source);
  return {
    path: written.path,
    mode: written.mode,
    auditId: written.auditId,
  };
}

export async function rejectCandidate(
  id: string,
): Promise<{ id: string; auditId: string }> {
  return { id, auditId: await retire(await candidate(id), "reject") };
}
