import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  oceanPath,
  PROJECTS_DIR,
  projectFolder,
  resolveWithin,
  WORKSPACE_PROJECT_ID,
} from "../../paths.js";

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
