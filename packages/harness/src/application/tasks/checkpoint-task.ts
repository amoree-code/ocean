import { readFile, writeFile } from "node:fs/promises";
import { resolveWithin, workspaceTasksRoot } from "../../paths.js";

export type CheckpointInput = {
  note: string;
  next?: string;
  date?: string;
};

/**
 * Append a durable checkpoint to a task's `## Log` and, when given, replace its
 * `## Next action`. Writing to the task file means the checkpoint survives a
 * cold restart: a later loop iteration or a fresh session reads it back from
 * disk rather than from in-memory state.
 */
export async function checkpointTask(
  id: string,
  root = workspaceTasksRoot(),
  input: CheckpointInput,
): Promise<{ checkpointed: string }> {
  if (!input.note?.trim()) throw new Error("Checkpoint requires a note.");
  const taskFile = resolveWithin(root, id, "task.md");
  let source = await readFile(taskFile, "utf8");
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const entry = `- ${date} — ${input.note.trim()}`;
  if (/^## Log\s*$/m.test(source))
    source = source.replace(/^## Log\s*$/m, `## Log\n\n${entry}`);
  else source = `${source.trimEnd()}\n\n## Log\n\n${entry}\n`;
  if (input.next?.trim()) {
    const next = input.next.trim();
    if (/^## Next action\s*$/m.test(source))
      source = source.replace(
        /^## Next action\s*$[\s\S]*?(?=^## |\s*$)/m,
        `## Next action\n\n${next}\n\n`,
      );
    else source = `${source.trimEnd()}\n\n## Next action\n\n${next}\n`;
  }
  await writeFile(taskFile, source, "utf8");
  return { checkpointed: id };
}
