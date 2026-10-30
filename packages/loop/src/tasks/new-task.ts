import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { localDate } from "@ocean/core/shared/local-date.js";
import {
  oceanPath,
  PROJECTS_DIR,
  projectFolder,
  resolveWithin,
} from "@ocean/core/shared/paths.js";
import { withNextTaskId } from "@ocean/core/shared/project-resolution.js";

// A new record in the shape `tasks doctor` validates and `tasks complete` can close: the
// definition of done is a checkbox, so it can be ticked rather than rewritten first.
export function taskRecord(input: {
  id: string;
  title: string;
  project: string;
  objective: string;
  today: string;
}): string {
  const { id, title, project, objective, today } = input;
  return `---\nid: ${id}\ntitle: ${JSON.stringify(title)}\nstate: active\nproject: ${project}\nopened: ${today}\nupdated: ${today}\nartifacts: []\nclass: medium\nexpected_context: medium\n---\n\n## Objective\n\n${objective}\n\n## Definition of done\n\n- [ ] The requested outcome is implemented and its verification passes.\n\n## Next action\n\nInspect the project and define the first implementation slice.\n\n## Verification\n\nPending.\n\n## Blockers\n\nNone.\n\n## Log\n\n- ${today} — Task created.\n`;
}

export function validTaskTitle(title: string | undefined): title is string {
  const trimmed = title?.trim();
  return Boolean(trimmed && trimmed.length <= 200 && !/[\r\n]/.test(trimmed));
}

// `ocean tasks new`: the next free id comes from the projects lock (the highest id on disk,
// live or archived, and the manifest counter), never from a hand-kept number.
export async function newTask(
  projectId: string,
  title: string,
): Promise<{ id: string; file: string }> {
  if (!validTaskTitle(title))
    throw new Error(
      "A task needs a single-line title of at most 200 characters",
    );
  // A mistyped project would otherwise get a fresh folder and an id from the shared namespace.
  const folder = resolveWithin(
    oceanPath(PROJECTS_DIR),
    projectFolder(projectId),
  );
  const isProject = await stat(folder).then(
    (entry) => entry.isDirectory(),
    () => false,
  );
  if (!isProject) throw new Error(`No project ${projectId} in ${PROJECTS_DIR}`);
  const today = localDate();
  const result = await withNextTaskId(projectId, async (id) => {
    const file = resolveWithin(
      oceanPath(PROJECTS_DIR),
      projectFolder(projectId),
      "tasks",
      id,
      "task.md",
    );
    await mkdir(path.dirname(file), { recursive: true });
    // `wx`: an id that already has a record is never overwritten.
    await writeFile(
      file,
      taskRecord({
        id,
        title: title.trim(),
        project: projectId,
        objective: title.trim(),
        today,
      }),
      { flag: "wx" },
    );
    return { ok: true, id, file };
  });
  return { id: result.id, file: result.file };
}
