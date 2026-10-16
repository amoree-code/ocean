import type { Dirent } from "node:fs";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import {
  parseTaskId,
  taskIdSpellings,
} from "@ocean/core/domain/tasks/task-id.js";
import { FRONTMATTER_READ_BYTES, readFrontmatterFile } from "../fs-utils.js";
import {
  isWorkspaceProject,
  oceanRoot,
  PROJECTS_DIR,
  projectFolder,
  resolveWithin,
} from "../paths.js";
import {
  folderProject,
  projectForPrefix,
  projectsWithTasks,
} from "./project-resolution.js";

// Archive namespace per project; the workspace project archives under "Ocean".
export const WORKSPACE_ARCHIVE_NAMESPACE = "Ocean";
export const projectArchiveName = (project: string): string =>
  isWorkspaceProject(project) ? WORKSPACE_ARCHIVE_NAMESPACE : project;

export type TaskLocation = {
  projectId: string;
  // The folder name the task lives under, which is what every file operation must use: the
  // reference the caller typed may be another spelling (T-3 for T-003) or a legacy id.
  id: string;
  file: string;
  archived: boolean;
};

export type TaskReferenceScope = {
  projectId?: string;
  cwd?: string;
  // --project was typed: never look in another project.
  explicit?: boolean;
  // false: stay inside the current project (governed operations, the context ladder).
  acrossProjects?: boolean;
  root?: string;
};

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

// One project's task by exact id: live first, then archive/<namespace>/<id>.
async function findInProject(
  projectsDir: string,
  project: string,
  id: string,
): Promise<TaskLocation | null> {
  const tasks = resolveWithin(projectsDir, projectFolder(project), "tasks");
  for (const spelling of taskIdSpellings(id)) {
    const live = resolveWithin(tasks, spelling, "task.md");
    if (await exists(live))
      return { projectId: project, id: spelling, file: live, archived: false };
  }
  for (const spelling of taskIdSpellings(id)) {
    const file = resolveWithin(
      tasks,
      "archive",
      projectArchiveName(project),
      spelling,
      "task.md",
    );
    if (await exists(file))
      return { projectId: project, id: spelling, file, archived: true };
  }
  return null;
}

async function directories(parent: string): Promise<Dirent[]> {
  try {
    return (await readdir(parent, { withFileTypes: true })).filter((entry) =>
      entry.isDirectory(),
    );
  } catch {
    return [];
  }
}

// Every task folder of a project, live and archived, as [folder name, task.md, archived].
export async function taskFolders(
  projectsDir: string,
  project: string,
): Promise<Array<[string, string, boolean]>> {
  const tasks = resolveWithin(projectsDir, projectFolder(project), "tasks");
  const found: Array<[string, string, boolean]> = [];
  for (const entry of await directories(tasks)) {
    if (entry.name !== "archive")
      found.push([entry.name, path.join(tasks, entry.name, "task.md"), false]);
  }
  const archive = path.join(tasks, "archive");
  for (const entry of await directories(archive)) {
    // archive/<namespace>/<id>, or a flat archive/<id>.
    if (await exists(path.join(archive, entry.name, "task.md")))
      found.push([entry.name, path.join(archive, entry.name, "task.md"), true]);
    else
      for (const inner of await directories(path.join(archive, entry.name)))
        found.push([
          inner.name,
          path.join(archive, entry.name, inner.name, "task.md"),
          true,
        ]);
  }
  return found;
}

// Tasks renumbered by `ocean tasks renumber` keep their old id in `legacyId`, so a reference
// written before the rename (a commit message, a handoff) still finds its task. Only the
// frontmatter head of each record is read.
async function findByLegacyId(
  projectsDir: string,
  projects: string[],
  wanted: { prefix: string; number: number },
): Promise<TaskLocation[]> {
  const hits: TaskLocation[] = [];
  for (const project of projects) {
    for (const [id, file, archived] of await taskFolders(
      projectsDir,
      project,
    )) {
      const record = await readFrontmatterFile(file, FRONTMATTER_READ_BYTES);
      const legacy = record?.fields.legacyId
        ? parseTaskId(record.fields.legacyId)
        : null;
      if (legacy?.prefix === wanted.prefix && legacy.number === wanted.number)
        hits.push({ projectId: project, id, file, archived });
    }
  }
  return hits;
}

// Resolves a task reference to the task that holds it (T-256). A prefixed id goes to the
// project that owns the prefix. A bare T id looks in the current project, then (unless told to
// stay) in whichever project holds it, then in `legacyId` fields. Ambiguity is an error, never
// a guess.
export async function resolveTaskReference(
  ref: string,
  scope: TaskReferenceScope = {},
): Promise<TaskLocation> {
  const parsed = parseTaskId(ref);
  if (!parsed) throw new Error(`'${ref}' is not a task id`);
  // As typed, prefix upper-cased: the spelling tried first (T-0003 may be a real folder name).
  const canonical = `${parsed.prefix}${ref.slice(ref.indexOf("-"))}`;
  const projectsDir = path.join(scope.root ?? oceanRoot(), PROJECTS_DIR);
  const acrossProjects = scope.acrossProjects !== false && !scope.explicit;
  const current =
    scope.projectId ?? (scope.cwd ? await folderProject(scope.cwd) : null);

  const owner = await projectForPrefix(parsed.prefix);
  if (owner) {
    if (
      current &&
      owner !== current &&
      (scope.explicit || scope.acrossProjects === false)
    )
      throw new Error(`${canonical} belongs to ${owner}, not ${current}`);
    const hit = await findInProject(projectsDir, owner, canonical);
    if (hit) return hit;
    throw new Error(`${canonical} is not a task in project ${owner}`);
  }
  if (parsed.prefix !== "T")
    throw new Error(`no project uses prefix ${parsed.prefix}`);

  if (current) {
    const hit = await findInProject(projectsDir, current, canonical);
    if (hit) return hit;
  }
  if (scope.explicit && current) {
    const legacy = await findByLegacyId(projectsDir, [current], parsed);
    if (legacy.length === 1) return legacy[0];
    throw new Error(`${canonical} is not a task in project ${current}`);
  }
  if (acrossProjects) {
    const projects = await projectsWithTasks();
    for (const archived of [false, true]) {
      const holders: TaskLocation[] = [];
      for (const project of projects) {
        const hit = await findInProject(projectsDir, project, canonical);
        if (hit && hit.archived === archived) holders.push(hit);
      }
      if (holders.length === 1) return holders[0];
      if (holders.length > 1)
        throw new Error(
          `${canonical} exists in ${holders.map((holder) => holder.projectId).join(", ")}; pass --project <id>`,
        );
    }
  }
  const legacy = await findByLegacyId(
    projectsDir,
    acrossProjects ? await projectsWithTasks() : current ? [current] : [],
    parsed,
  );
  if (legacy.length === 1) return legacy[0];
  if (legacy.length > 1)
    throw new Error(
      `${canonical} was the old id of tasks in ${legacy.map((hit) => hit.projectId).join(", ")}; pass --project <id>`,
    );
  throw new Error(`${canonical} is not a task in any project`);
}
