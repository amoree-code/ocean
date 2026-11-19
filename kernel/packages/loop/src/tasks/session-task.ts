import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  parseTaskId,
  taskIdSpellings,
} from "@ocean/core/domain/tasks/task-id.js";
import { parseFrontmatter } from "@ocean/core/shared/fs-utils.js";
import {
  BRAIN_RECORD_DIRS,
  CHARTER_DIR,
  listProjectDirs,
  oceanPath,
  oceanRoot,
  SYSTEM_DIR,
} from "@ocean/core/shared/paths.js";
import { CLAIM_TTL_MS } from "./claim-task.js";

// Which task a new session belongs to (T-319), when nothing named one. Three signals, in order,
// and only an unambiguous answer counts — a wrong task id is worse than none:
//   1. the working directory is inside a task's own folder (`04-projects/…/tasks/T-296`);
//   2. the git branch names a task (`feat/t318-scorecard` → T-318) — skipped inside a workspace
//      area that never holds code (`02-personal`, `01-daily`, `bridge`…): the Ocean workspace
//      is one repository, so a notes session there sits on whatever branch the kernel is on;
//   3. the working directory lies inside exactly one live claim's `claimed_paths`.
// A cancelled or archived task never matches; a done one still does (a session on its branch is
// about it).

export type SessionTaskCandidate = {
  id: string;
  project: string;
  state: string;
  claim: { at: string; paths: string[] } | null;
  // The task's own folder, absolute.
  dir?: string;
};

// Task-id-shaped tokens in a branch name: `t318`, `t-318`, `cws-003`, `cws3`.
export function branchTaskTokens(branch: string): string[] {
  const tokens = new Set<string>();
  for (const match of branch.matchAll(
    /(?:^|[/_.-])([a-z][a-z0-9]{0,5}?)-?(\d{1,6})(?=$|[/_.-])/gi,
  )) {
    const parsed = parseTaskId(`${match[1]}-${match[2]}`);
    if (parsed) tokens.add(`${parsed.prefix}-${parsed.number}`);
  }
  return [...tokens];
}

const sameTask = (token: string, id: string) =>
  taskIdSpellings(token).some(
    (spelling) => spelling.toUpperCase() === id.toUpperCase(),
  );

const inside = (dir: string, parent: string) => {
  const relative = path.relative(parent, dir);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

export function taskForSession(input: {
  cwd: string;
  branch: string | null;
  projectId: string | null;
  candidates: SessionTaskCandidate[];
  root: string;
  // Absolute workspace areas where a branch says nothing about the session.
  noCodeDirs?: string[];
  now?: Date;
}): string | null {
  const now = (input.now ?? new Date()).getTime();
  const live = input.candidates.filter((task) => task.state !== "cancelled");
  // 1. The task's own folder.
  const home = live.filter((task) => task.dir && inside(input.cwd, task.dir));
  if (home.length === 1) return home[0].id;
  // 2. The branch, where the directory can hold code.
  const codeDir = !(input.noCodeDirs ?? []).some((dir) =>
    inside(input.cwd, dir),
  );
  const tokens = input.branch && codeDir ? branchTaskTokens(input.branch) : [];
  const named = live.filter((task) =>
    tokens.some((token) => sameTask(token, task.id)),
  );
  const inProject = named.filter((task) => task.project === input.projectId);
  const byBranch = inProject.length ? inProject : named;
  // One task, not one id: T-5 in two projects is two tasks.
  if (new Set(byBranch.map((task) => `${task.project}/${task.id}`)).size === 1)
    return byBranch[0].id;
  if (byBranch.length > 1) return null;
  // 3. A live claim on a path holding the working directory.
  const claimed = live.filter(
    (task) =>
      task.claim &&
      now - Date.parse(task.claim.at) <= CLAIM_TTL_MS &&
      task.claim.paths.some((entry) =>
        inside(input.cwd, path.join(input.root, entry)),
      ),
  );
  return claimed.length === 1 ? claimed[0].id : null;
}

// The branch checked out at `cwd`, read from .git/HEAD (a worktree's `.git` file points at its
// own HEAD); null when detached or outside a repository. No git process is started.
export async function gitBranchAt(cwd: string): Promise<string | null> {
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, ".git");
    let gitDir: string | null = null;
    try {
      const text = await readFile(dotGit, "utf8");
      const pointer = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
      if (pointer) gitDir = path.resolve(dir, pointer);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EISDIR") gitDir = dotGit;
      else if (code !== "ENOENT" && code !== "ENOTDIR") return null;
    }
    if (gitDir) {
      const head = await readFile(path.join(gitDir, "HEAD"), "utf8").catch(
        () => "",
      );
      return /^ref:\s*refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim() ?? null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Every task folder in every project (archive/ excluded), with its state and claim.
export async function sessionTaskCandidates(): Promise<SessionTaskCandidate[]> {
  const candidates: SessionTaskCandidate[] = [];
  for (const { id: project, dir } of listProjectDirs()) {
    const root = oceanPath(dir, "tasks");
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === "archive") continue;
      const source = await readFile(
        path.join(root, entry, "task.md"),
        "utf8",
      ).catch(() => "");
      if (!source) continue;
      const fields = parseFrontmatter(source);
      const paths = (fields.claimed_paths?.match(/^\[(.*)\]$/)?.[1] ?? "")
        .split(",")
        .map((item) => item.trim().replace(/^\.\//, "").replace(/\/+$/, ""))
        .filter(Boolean);
      candidates.push({
        dir: path.join(root, entry),
        id: fields.id || entry,
        project,
        state: fields.state ?? "",
        claim:
          fields.claimed_by && fields.claimed_at
            ? { at: fields.claimed_at, paths }
            : null,
      });
    }
  }
  return candidates;
}

// What every session-creating path calls when no task was named. Never throws: a session is
// still recorded when the workspace cannot be read.
export async function resolveSessionTask(
  cwd: string,
  projectId: string | null,
): Promise<string | null> {
  try {
    return taskForSession({
      cwd,
      branch: await gitBranchAt(cwd),
      projectId,
      candidates: await sessionTaskCandidates(),
      root: oceanRoot(),
      noCodeDirs: [...BRAIN_RECORD_DIRS, SYSTEM_DIR, CHARTER_DIR].map((dir) =>
        oceanPath(dir),
      ),
    });
  } catch {
    return null;
  }
}
