import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { MemoryContractError } from "@ocean/core/domain/mcp/memory-contract.js";
import { atomicWrite, withFileLock } from "@ocean/core/shared/fs-utils.js";
import { localDate } from "@ocean/core/shared/local-date.js";
import {
  oceanPath,
  PROJECTS_DIR,
  projectDir,
} from "@ocean/core/shared/paths.js";
import {
  findProject,
  readClaudeProjects,
  registerNamedProject,
} from "@ocean/core/shared/project-resolution.js";
import {
  appendAudit,
  memorySettings,
  newId,
  sha256,
  writeDurable,
} from "./memory-audit.js";
import { assertNoLinks, candidatesRoot, storedCopy } from "./memory-paths.js";
import {
  checkContent,
  proposeMemory,
  readMemoryRecord,
  writeMemoryRecord,
} from "./memory-write.js";
import { isSessionFactSource } from "./session-facts.js";

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
  // A fact captured from a session transcript (T-313) is the model's reading of a conversation:
  // only the owner approves it, whatever proposeAutoApprove or pullAutoApprove say.
  if (isSessionFactSource(item.source) && source !== "owner-review")
    throw new MemoryContractError(
      "PROTECTED",
      "a fact captured from a session waits for the owner's review",
    );
  const provenance = {
    origin: item.origin === "imported" ? "imported" : "inferred",
    candidate: options.id,
  } as const;
  if (item.meta.kind === "todo" && !options.to)
    return approveTodo(item, source);
  const target = options.to ?? item.target;
  if (!target)
    throw new MemoryContractError(
      "INVALID",
      "the candidate names no target; pass --to <record path>",
    );
  // A project doc is only ever created: an existing one stays the owner's (T-307).
  if (/^04-projects\/[^/]+\/docs\//.test(target)) {
    const written = await writeMemoryRecord({
      path: target,
      content: item.content,
      mode: "create",
      source,
      provenance,
      document: true,
    });
    await retire(item, "approve", source);
    return { path: written.path, mode: "create", auditId: written.auditId };
  }
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
        provenance,
      })
    : await writeMemoryRecord({
        path: target,
        content: item.content,
        mode: "create",
        source,
        provenance,
      });
  await retire(item, "approve", source);
  return {
    path: written.path,
    mode: written.mode,
    auditId: written.auditId,
  };
}

const BACKLOG = `${PROJECTS_DIR}/backlog.md`;

// An approved todo is one line under the backlog's "## Open" heading, never a task folder:
// a task is opened only at the owner's request. The backlog before the change is kept in
// versions/ and the audit names the candidate it came from.
async function approveTodo(
  item: Candidate,
  source: string,
): Promise<{ path: string; mode: "update"; auditId: string }> {
  checkContent(item.content);
  const project =
    typeof item.meta.project === "string" ? item.meta.project : "workspace";
  const text = item.content.replace(/\s+/g, " ").trim().slice(0, 300);
  const line = `- [TODO] (P2) ${project} — ${text} {${localDate()}}`;
  const file = oceanPath(BACKLOG);
  assertNoLinks(oceanPath(), file);
  const id = newId();
  const { before, after, copy } = await withFileLock(file, async () => {
    const current = await readFile(file, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    const base = current ?? "# Backlog\n\n## Open\n\n";
    const open = "## Open\n\n";
    const at = base.indexOf(open);
    const next =
      at < 0
        ? `${base.replace(/\n*$/, "\n\n")}${line}\n`
        : `${base.slice(0, at + open.length)}${line}\n${base.slice(at + open.length)}`;
    let copy: string | undefined;
    if (current !== null) {
      const stored = storedCopy("versions", id, BACKLOG);
      await writeDurable(stored, current);
      copy = path.relative(oceanPath(), stored).split(path.sep).join("/");
    }
    await atomicWrite(file, next);
    return { before: current, after: next, copy };
  });
  await appendAudit({
    id,
    action: before === null ? "create" : "update",
    path: BACKLOG,
    source,
    origin: item.origin === "imported" ? "imported" : "inferred",
    candidate: item.id,
    beforeSha: before === null ? null : sha256(before),
    afterSha: sha256(after),
    copy,
  });
  await retire(item, "approve", source);
  return { path: BACKLOG, mode: "update", auditId: id };
}

export type ProposalKind = "fact" | "doc" | "todo";
const KINDS: ProposalKind[] = ["fact", "doc", "todo"];
const NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;

// A client's proposal made inside a project (T-307). The project is named by its Ocean id or its
// name (`LetSpeak` finds `letspeak`). Ocean, not the client, picks the place from the kind: a
// fact goes to the project's memory/ and a doc to its docs/, each as the new file `<name>.md`; a
// todo waits for review and becomes one backlog line. With proposeAutoApprove on, a fact or doc
// for an existing project is written at once — never over or into an existing file — and keeps
// its origin and candidate in the audit; a name Ocean does not know is registered as a project
// only when it is one of the owner's Claude projects this machine has seen, never for a topic a
// client calls a project. Everything else stays a candidate.
export async function fileProposal(options: {
  content: string;
  origin: "inferred" | "imported";
  project: string;
  kind: ProposalKind;
  name?: string;
  reason?: string;
  source?: string;
}): Promise<{
  candidate: string;
  auditId: string;
  filed?: string;
  registered?: string;
  review?: string;
}> {
  if (!KINDS.includes(options.kind))
    throw new MemoryContractError("INVALID", "kind must be fact, doc or todo");
  const ref = typeof options.project === "string" ? options.project.trim() : "";
  if (!ref || ref.length > 64 || /[\r\n/\\]/.test(ref))
    throw new MemoryContractError(
      "INVALID",
      "project must be a project id or name of at most 64 characters",
    );
  if (
    options.kind !== "todo" &&
    (typeof options.name !== "string" || !NAME.test(options.name))
  )
    throw new MemoryContractError(
      "INVALID",
      "name must be lowercase kebab-case, at most 60 characters",
    );
  const auto = (await memorySettings()).proposeAutoApprove;
  let project = await findProject(ref);
  let registered: string | undefined;
  if (
    !project &&
    auto &&
    (await readClaudeProjects()).some(
      (name) => name.trim().toLowerCase() === ref.toLowerCase(),
    )
  ) {
    try {
      project = (await registerNamedProject(ref, ["claude.ai"])).id;
      registered = project;
    } catch {
      // an id that cannot be made, or a folder without a manifest: the owner decides
    }
  }
  const folder = options.kind === "fact" ? "memory" : "docs";
  const target =
    project && options.kind !== "todo"
      ? `${projectDir(project)}/${folder}/${options.name}.md`
      : undefined;
  const proposed = await proposeMemory({
    content: options.content,
    origin: options.origin,
    target,
    reason: options.reason,
    source: options.source,
    meta: { kind: options.kind, project: project ?? ref },
  });
  const result = { ...proposed, ...(registered ? { registered } : {}) };
  if (!project)
    return {
      ...result,
      review: `'${ref}' is neither an Ocean project nor a Claude project this machine has seen; waits for review`,
    };
  if (!target) return { ...result, review: "a todo waits for review" };
  if (!auto)
    return {
      ...result,
      review: "proposeAutoApprove is off; waits for review",
    };
  try {
    const written = await approveCandidate({
      id: path.basename(proposed.candidate, ".md"),
      createOnly: true,
      source: "propose-auto-approve",
    });
    return { ...result, filed: written.path };
  } catch (error) {
    if (!(error instanceof MemoryContractError)) throw error;
    return { ...result, review: `${error.message}; waits for review` };
  }
}

export async function rejectCandidate(
  id: string,
): Promise<{ id: string; auditId: string }> {
  return { id, auditId: await retire(await candidate(id), "reject") };
}
