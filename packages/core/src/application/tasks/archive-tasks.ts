import type { Dirent } from "node:fs";
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  isWorkspaceProject,
  resolveWithin,
  WORKSPACE_PROJECT_ID,
  workspaceTasksRoot,
} from "../../paths.js";
import { type CommandRunner, verifyTask } from "./verify-task.js";

export type ArchiveResult = {
  candidates: string[];
  skipped: Array<{ id: string; reason: string }>;
  moved: string[];
  repaired: string[];
};

export type CompletionResult = ArchiveResult & { id: string; state: "done" };

const field = (source: string, name: string): string =>
  source
    .match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]
    ?.trim()
    .replace(/^['"]|['"]$/g, "") ?? "";

// Archive namespace per project; the workspace project archives under "Ocean".
const WORKSPACE_ARCHIVE_NAMESPACE = "Ocean";
export const projectArchiveName = (project: string): string =>
  isWorkspaceProject(project) ? WORKSPACE_ARCHIVE_NAMESPACE : project;

function setState(source: string, state: string): string {
  return source.replace(/^state:\s*.+$/m, `state: ${state}`);
}

export async function completeTask(
  id: string,
  root = workspaceTasksRoot(),
  options: { verify?: boolean; cwd?: string; run?: CommandRunner } = {},
): Promise<CompletionResult> {
  const taskFile = resolveWithin(root, id, "task.md");
  const source = await readFile(taskFile, "utf8");
  const checklist = source.match(/- "\[[ x]\] .*"/g);
  if (checklist) {
    if (checklist.some((line) => line.includes("[ ]")))
      throw new Error(`Cannot complete ${id}: unchecked work`);
  } else {
    const verification = source
      .match(/\n## Verification\n\n([\s\S]*?)(?=\n## |$)/)?.[1]
      ?.trim();
    if (!verification || /^pending\b/i.test(verification))
      throw new Error(`Cannot complete ${id}: verification is pending`);
  }
  // An independent check must pass before the task is marked done — a
  // self-reported `state: done` is never enough on its own.
  if (options.verify) {
    const outcome = await verifyTask(id, root, {
      cwd: options.cwd,
      run: options.run,
    });
    if (!outcome.passed)
      throw new Error(`Cannot complete ${id}: ${outcome.reason}`);
  }
  if (field(source, "state") !== "done")
    await writeFile(taskFile, setState(source, "done"));
  const archived = await archiveDoneTasks(root, true);
  return { id, state: "done", ...archived };
}

export async function archiveDoneTasks(
  root = workspaceTasksRoot(),
  apply = false,
): Promise<ArchiveResult> {
  const result: ArchiveResult = {
    candidates: [],
    skipped: [],
    moved: [],
    repaired: [],
  };
  const archiveRoot = resolveWithin(root, "archive");
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "archive") continue;
    const sourceDirectory = resolveWithin(root, entry.name);
    const taskFile = resolveWithin(root, entry.name, "task.md");
    try {
      await access(taskFile);
    } catch {
      const archivedDirectory = resolveWithin(
        archiveRoot,
        WORKSPACE_ARCHIVE_NAMESPACE,
        entry.name,
      );
      try {
        await access(path.join(archivedDirectory, "task.md"));
      } catch {
        continue; // not archived
      }
      if (!apply) continue;
      for (const artifact of await readdir(sourceDirectory, {
        withFileTypes: true,
      })) {
        const destination = resolveWithin(archivedDirectory, artifact.name);
        try {
          await access(destination);
          result.skipped.push({
            id: entry.name,
            reason: `archive artifact exists: ${artifact.name}`,
          });
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await rename(path.join(sourceDirectory, artifact.name), destination);
      }
      try {
        await rmdir(sourceDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
      }
      result.repaired.push(entry.name);
      continue;
    }
    const source = await readFile(taskFile, "utf8");
    const id = field(source, "id") || entry.name;
    const state = field(source, "state");
    if (state !== "done" && state !== "cancelled") continue;
    if (source.match(/- "\[ \] /)) {
      result.skipped.push({ id, reason: "unchecked work" });
      continue;
    }
    result.candidates.push(id);
    if (!apply) continue;

    const project = field(source, "project") || WORKSPACE_PROJECT_ID;
    const destinationDirectory = resolveWithin(
      archiveRoot,
      projectArchiveName(project),
      id,
    );
    try {
      await access(destinationDirectory);
      result.skipped.push({ id, reason: "archive destination exists" });
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(path.dirname(destinationDirectory), { recursive: true });
    await rename(sourceDirectory, destinationDirectory);
    result.moved.push(id);
  }
  return result;
}
