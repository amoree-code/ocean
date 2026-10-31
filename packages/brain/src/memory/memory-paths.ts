import { lstatSync } from "node:fs";
import path from "node:path";
import { isValidProjectId } from "@ocean/core/domain/context/project-id.js";
import { MemoryContractError } from "@ocean/core/domain/mcp/memory-contract.js";
import {
  INBOX_DIR,
  oceanPath,
  PERSONAL_DIR,
  PROJECTS_DIR,
  resolveWithin,
  SYSTEM_DIR,
} from "@ocean/core/shared/paths.js";

// Every place the memory tools may write, and nothing else (T-296). Permanent records are the
// only paths a caller chooses; candidates, versions, trash, the audit log and the client
// journal are named by the server. Native staging belongs to a client's own memory feature.

// Indexes and the conflicts list are maintained by Ocean itself, never written as records.
const PROTECTED = new Set([
  "memory.md",
  "knowledge.md",
  "projects.md",
  "conflicts.md",
  "inbox.md",
]);

const clientIdPattern = /^[a-z0-9][a-z0-9-]{0,40}$/;

export type PermanentRecord = {
  file: string;
  // Workspace-relative, `/`-separated: the form audit entries and tool results carry.
  relative: string;
  root: string;
  personal: boolean;
};

function workspaceRelative(file: string): string {
  return path.relative(oceanPath(), file).split(path.sep).join("/");
}

// A symlink anywhere from the root down, or a hard-linked target, could make a write land in a
// file outside the record the caller named; resolveWithin alone accepts in-root symlinks.
export function assertNoLinks(root: string, file: string): void {
  const resolvedRoot = path.resolve(root);
  const parts = path.relative(resolvedRoot, path.resolve(file)).split(path.sep);
  let current = resolvedRoot;
  for (const part of ["", ...parts]) {
    current = part ? path.join(current, part) : current;
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stats.isSymbolicLink())
      throw new MemoryContractError(
        "SYMLINK",
        `${workspaceRelative(current)} is a symbolic link`,
      );
    if (current === path.resolve(file) && stats.isFile() && stats.nlink > 1)
      throw new MemoryContractError(
        "HARDLINK",
        `${workspaceRelative(current)} has more than one hard link`,
      );
  }
}

function segments(relative: string): string[] {
  if (
    typeof relative !== "string" ||
    !relative ||
    relative.includes("\0") ||
    path.isAbsolute(relative) ||
    /^[A-Za-z]:/.test(relative)
  )
    throw new MemoryContractError(
      "OUT_OF_ROOT",
      "path must be a relative path inside the workspace",
    );
  const parts = relative.split(/[\\/]/);
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    throw new MemoryContractError(
      "OUT_OF_ROOT",
      "path must not contain empty, '.' or '..' segments",
    );
  if (parts.some((part) => part.startsWith(".")))
    throw new MemoryContractError(
      "OUT_OF_ROOT",
      "path must not contain hidden segments",
    );
  return parts;
}

// A permanent record: `02-personal/**/*.md` or `04-projects/<id>/memory/**/*.md`.
export function permanentRecord(relative: string): PermanentRecord {
  const parts = segments(relative);
  const name = parts.at(-1) ?? "";
  if (!name.toLowerCase().endsWith(".md"))
    throw new MemoryContractError("INVALID", "a record must be a .md file");
  if (PROTECTED.has(name.toLowerCase()))
    throw new MemoryContractError(
      "PROTECTED",
      `${name} is maintained by Ocean, not written as a record`,
    );
  const joined = parts.join("/");
  const under = (dir: string) =>
    joined.startsWith(`${dir}/`)
      ? joined.slice(dir.length + 1).split("/")
      : null;
  let root: string;
  let rest: string[];
  const personal = under(PERSONAL_DIR);
  const [project, folder, ...inProject] = under(PROJECTS_DIR) ?? [];
  if (personal) {
    root = oceanPath(PERSONAL_DIR);
    rest = personal;
  } else if (
    project &&
    folder === "memory" &&
    inProject.length &&
    isValidProjectId(project)
  ) {
    root = oceanPath(PROJECTS_DIR, project, "memory");
    rest = inProject;
  } else
    throw new MemoryContractError(
      "OUT_OF_ROOT",
      `records live under ${PERSONAL_DIR}/ or ${PROJECTS_DIR}/<project>/memory/`,
    );
  let file: string;
  try {
    file = resolveWithin(root, ...rest);
  } catch {
    throw new MemoryContractError("OUT_OF_ROOT", "path escapes its root");
  }
  assertNoLinks(root, file);
  return {
    file,
    relative: workspaceRelative(file),
    root,
    personal: Boolean(personal),
  };
}

function stateDir(...parts: string[]): string {
  return oceanPath(SYSTEM_DIR, "state", ...parts);
}

export function candidatesRoot(): string {
  return oceanPath(INBOX_DIR, "candidates");
}

// Server-named only: <candidates>/<yyyy-mm-dd>/<id>.md.
export function candidateFile(day: string, id: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^[0-9a-z-]{8,64}$/.test(id))
    throw new MemoryContractError("INVALID", "bad candidate name");
  const root = candidatesRoot();
  const file = resolveWithin(root, day, `${id}.md`);
  assertNoLinks(root, file);
  return file;
}

// Where a client's own memory feature is redirected to (e.g. Claude Code's
// autoMemoryDirectory). Ocean only reads it, to turn its files into candidates.
export function stagingDir(client: string): string {
  if (!clientIdPattern.test(client))
    throw new MemoryContractError("INVALID", `bad client id '${client}'`);
  return resolveWithin(oceanPath(INBOX_DIR, "native"), client);
}

export function versionsRoot(): string {
  return stateDir("memory", "versions");
}

export function trashRoot(): string {
  return stateDir("memory", "trash");
}

// A stored copy of a record: <versions|trash>/<id>/<workspace-relative path>.
export function storedCopy(
  kind: "versions" | "trash",
  id: string,
  relative: string,
): string {
  const root = kind === "versions" ? versionsRoot() : trashRoot();
  if (!/^[0-9a-z-]{8,64}$/.test(id))
    throw new MemoryContractError("INVALID", "bad stored copy id");
  const file = resolveWithin(root, id, ...segments(relative));
  assertNoLinks(root, file);
  return file;
}

// Content hashes of harvested native-memory texts → their candidate (T-296 P4).
export function harvestLedgerFile(): string {
  return stateDir("memory", "harvest.json");
}

export function auditFile(): string {
  return stateDir("memory", "audit.jsonl");
}

// The client-configuration journal (P2): only Ocean-managed values, never whole client files.
export function clientJournalFile(): string {
  return stateDir("clients", "journal.jsonl");
}
