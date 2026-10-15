import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  parseTaskId,
  taskIdSpellings,
} from "@ocean/core/domain/tasks/task-id.js";
import {
  oceanPath,
  PROJECTS_DIR,
  projectFolder,
  resolveWithin,
  WORKSPACE_PROJECT_ID,
} from "../../paths.js";
import { resolveProject } from "../context/project-resolution.js";

export type TaskSummary = {
  id: string;
  title: string;
  state: string;
  goal: string;
  updatedAt: string;
};

/**
 * Read task summaries for a project from the workspace. Lives in the application
 * layer so both the CLI (`ocean tasks list`) and the MCP server can call it
 * without the MCP server reaching back into the CLI layer.
 */
export async function listTasks(
  state?: string,
  projectId = WORKSPACE_PROJECT_ID,
): Promise<TaskSummary[]> {
  const root = resolveWithin(
    oceanPath(PROJECTS_DIR),
    projectFolder(projectId),
    "tasks",
  );
  const records: TaskSummary[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return records;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "archive") continue;
    const file = path.join(root, entry.name, "task.md");
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const fields = Object.fromEntries(
      source
        .slice(0, source.indexOf("\n---", 4))
        .split("\n")
        .slice(1)
        .filter((line) => /^[\w-]+:/.test(line))
        .map((line) => {
          const index = line.indexOf(":");
          const value = line.slice(index + 1).trim();
          return [line.slice(0, index), value.replace(/^(["'])(.*)\1$/, "$2")];
        }),
    );
    if (state && fields.state !== state) continue;
    const objective =
      source.match(/\n## Objective\n\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ??
      "";
    records.push({
      id: fields.id ?? entry.name,
      title: fields.title ?? "",
      state: fields.state ?? "",
      goal: objective || fields.goal || fields.requirement || "",
      updatedAt: fields.updated ?? fields.updated_at ?? "",
    });
  }
  return records.sort((a, b) => a.id.localeCompare(b.id));
}

// Project folders under 04-projects that hold a tasks/ directory, sorted.
export async function projectsWithTasks(): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(oceanPath(PROJECTS_DIR), { withFileTypes: true });
  } catch {
    return [];
  }
  const projects: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      await readdir(path.join(oceanPath(PROJECTS_DIR), entry.name, "tasks"));
      projects.push(entry.name);
    } catch {
      /* no tasks/ here */
    }
  }
  return projects.sort();
}

// Projects whose live tasks/ holds this id (T-3 and T-003 are one task). Ids are unique per
// project, not across projects.
export async function projectsHoldingTask(id: string): Promise<string[]> {
  if (!parseTaskId(id)) return [];
  const holders: string[] = [];
  for (const project of await projectsWithTasks()) {
    for (const spelling of taskIdSpellings(id)) {
      try {
        await readFile(
          path.join(
            oceanPath(PROJECTS_DIR),
            project,
            "tasks",
            spelling,
            "task.md",
          ),
          "utf8",
        );
        holders.push(project);
        break;
      } catch {
        /* not here */
      }
    }
  }
  return holders;
}

// The project a folder belongs to, or null when it belongs to none. A registry that cannot be
// read throws: no guessing which project a folder is.
export async function folderProject(cwd: string): Promise<string | null> {
  const resolution = await resolveProject(cwd);
  return resolution.status === "bound" ? resolution.projectId : null;
}

export type ProjectTask = TaskSummary & { project: string };

export type FolderTasks = {
  // "project": one project's tasks; "all": every project's, because there was nothing narrower.
  scope: "project" | "all";
  project: string | null;
  tasks: ProjectTask[];
  note?: string;
};

// "What tasks do I have" from a folder (T-256): --project wins; else the folder's project when
// it has matching tasks; else every project's, labelled, with a note saying why.
export async function listTasksForFolder(options: {
  cwd: string;
  project?: string;
  state?: string;
}): Promise<FolderTasks> {
  const { state } = options;
  const label = (project: string, tasks: TaskSummary[]): ProjectTask[] =>
    tasks.map((task) => ({ ...task, project }));
  if (options.project) {
    // A mistyped id would otherwise read as a project with no tasks.
    // resolveWithin throws on its own for an id that escapes the projects root.
    const folder = resolveWithin(
      oceanPath(PROJECTS_DIR),
      projectFolder(options.project),
    );
    const isProject = await stat(folder).then(
      (entry) => entry.isDirectory(),
      () => false,
    );
    if (!isProject)
      throw new Error(`No project ${options.project} in ${PROJECTS_DIR}`);
    return {
      scope: "project",
      project: options.project,
      tasks: label(options.project, await listTasks(state, options.project)),
    };
  }
  const project = await folderProject(options.cwd);
  if (project) {
    const own = await listTasks(state, project);
    if (own.length)
      return { scope: "project", project, tasks: label(project, own) };
  }
  const tasks: ProjectTask[] = [];
  for (const each of await projectsWithTasks())
    tasks.push(...label(each, await listTasks(state, each)));
  const which = state ? `${state} ` : "";
  return {
    scope: "all",
    project,
    tasks,
    note: project
      ? `No ${which}tasks in ${project}; showing every project.`
      : `This folder is not an Ocean project; showing every project's ${which}tasks.`,
  };
}
