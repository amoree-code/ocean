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

export type ArchiveOptions = {
  cwd?: string;
  run?: CommandRunner;
  /** Tasks whose verification already passed in this completion flow. */
  verified?: ReadonlySet<string>;
  /** Restrict a completion flow to archiving only its own task. */
  only?: ReadonlySet<string>;
};

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

function section(source: string, heading: string): string | undefined {
  const header = new RegExp(`^## ${heading}[ \\t]*\\r?$`, "m").exec(source);
  if (!header) return undefined;
  const start = source.indexOf("\n", header.index) + 1;
  const nextHeading = /^## /m.exec(source.slice(start));
  return source.slice(
    start,
    nextHeading ? start + nextHeading.index : source.length,
  );
}

function completionIssues(source: string): string[] {
  const issues: string[] = [];
  if (/^\s*-\s+"?\[ \] /m.test(source)) issues.push("unchecked work");
  const blockers = section(source, "Blockers");
  if (blockers === undefined) {
    issues.push("missing Blockers section");
  } else {
    const entries = blockers
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const open = entries.filter((line) => {
      if (/^(?:[-*]\s*)?(?:none|no blockers?)\.?$/i.test(line)) return false;
      const checkbox = line.match(/^[-*]\s+\[([ xX])\]\s+.+$/);
      if (checkbox) return checkbox[1].toLowerCase() !== "x";
      return true;
    });
    if (open.length) issues.push("unresolved blockers");
  }

  const definition = section(source, "Definition of done");
  if (definition === undefined) {
    issues.push("missing Definition of done section");
  } else {
    const criteria = definition
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!criteria.length) {
      issues.push("missing acceptance criteria");
    } else {
      const unchecked = criteria.some((line) => {
        const checkbox = line.match(/^[-*]\s+\[([ xX])\]\s+.+$/);
        if (!checkbox) return true;
        return checkbox[1].toLowerCase() !== "x";
      });
      const malformed = criteria.some(
        (line) => !/^[-*]\s+\[([ xX])\]\s+.+$/.test(line),
      );
      if (malformed) issues.push("acceptance criteria must use checked boxes");
      else if (unchecked) issues.push("unchecked acceptance criteria");
    }
  }
  return issues;
}

export async function completeTask(
  id: string,
  root = workspaceTasksRoot(),
  options: { cwd?: string; run?: CommandRunner } = {},
): Promise<CompletionResult> {
  const taskFile = resolveWithin(root, id, "task.md");
  const source = await readFile(taskFile, "utf8");
  const issues = completionIssues(source);
  if (issues.length)
    throw new Error(`Cannot complete ${id}: ${issues.join("; ")}`);

  const outcome = await verifyTask(id, root, {
    cwd: options.cwd,
    run: options.run,
  });
  if (!outcome.passed)
    throw new Error(`Cannot complete ${id}: ${outcome.reason}`);

  if (field(source, "state") !== "done")
    await writeFile(taskFile, setState(source, "done"));
  const archived = await archiveDoneTasks(root, true, {
    ...options,
    verified: new Set([id]),
    only: new Set([id]),
  });
  const skipped = archived.skipped.find((entry) => entry.id === id);
  if (skipped) {
    await writeFile(taskFile, source, "utf8");
    throw new Error(`Cannot complete ${id}: ${skipped.reason}`);
  }
  return { id, state: "done", ...archived };
}

export async function archiveDoneTasks(
  root = workspaceTasksRoot(),
  apply = false,
  options: ArchiveOptions = {},
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
    if (options.only && !options.only.has(id)) continue;
    if (state === "done") {
      const issues = completionIssues(source);
      if (issues.length) {
        result.skipped.push({ id, reason: issues.join("; ") });
        continue;
      }
      if (apply && !options.verified?.has(id)) {
        const outcome = await verifyTask(id, root, {
          cwd: options.cwd,
          run: options.run,
        });
        if (!outcome.passed) {
          result.skipped.push({ id, reason: outcome.reason });
          continue;
        }
      }
    }
    if (state === "cancelled" && source.match(/^\s*-\s+"?\[ \] /m)) {
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
