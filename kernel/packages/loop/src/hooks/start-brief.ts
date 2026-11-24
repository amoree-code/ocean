import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DAILY_DIR, oceanPath } from "@ocean/core/shared/paths.js";
import { listTasks } from "../tasks/list-tasks.js";

// The start brief (T-329 phase 5): where the project stands, in a few pointer lines beside the
// bootstrap — its live tasks with their next action, and the last session's next step. Pointers
// only (ids, titles, one-line next steps), never a record's body: T-198 still holds.
export const START_BRIEF_MAX_BYTES = 600;
const ITEM_MAX_CHARS = 170;
const MAX_TASKS = 3;
// Session files read, newest first, before giving up on finding this project's last one.
const MAX_SESSION_FILES = 300;
const LIVE_STATES = new Set(["active", "in-qa", "blocked"]);

const clip = (text: string, max = ITEM_MAX_CHARS) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export type LastSession = { date: string; title: string; next: string };

const frontmatterField = (text: string, key: string) =>
  new RegExp(`^${key}:\\s*"?([^"\\n]*)"?\\s*$`, "m").exec(
    text.slice(0, text.indexOf("\n---", 4)),
  )?.[1] ?? "";

// The newest session record of this project, by file name (records start with their date and
// time). The archive is left alone: an archived session is not where the project stands.
export async function lastProjectSession(
  projectId: string,
): Promise<LastSession | null> {
  const root = oceanPath(DAILY_DIR, "sessions");
  let months: string[];
  try {
    months = (await readdir(root, { withFileTypes: true }))
      .filter(
        (entry) => entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return null;
  }
  let read = 0;
  for (const month of months) {
    let files: string[];
    try {
      files = (await readdir(path.join(root, month)))
        .filter((name) => name.endsWith(".md"))
        .sort()
        .reverse();
    } catch {
      continue;
    }
    for (const name of files) {
      if (read++ >= MAX_SESSION_FILES) return null;
      let text: string;
      try {
        text = await readFile(path.join(root, month, name), "utf8");
      } catch {
        continue;
      }
      if (frontmatterField(text, "type") !== "session") continue;
      if (frontmatterField(text, "project") !== projectId) continue;
      const next =
        /\n## Next\n\n([\s\S]*?)(?=\n## |$)/
          .exec(text)?.[1]
          ?.split("\n")
          .map((line) => line.replace(/^[-*]\s+/, "").trim())
          .find(Boolean) ?? "";
      return {
        date: frontmatterField(text, "date"),
        title: /^# (.+)$/m.exec(text)?.[1]?.trim() ?? name,
        next,
      };
    }
  }
  return null;
}

// The brief for a project Ocean knows, or null when there is nothing to say. Never throws: a
// session must keep its bootstrap whatever state the workspace is in.
export async function startBrief(projectId: string): Promise<string | null> {
  const [tasks, last] = await Promise.all([
    listTasks(undefined, projectId).catch(() => []),
    lastProjectSession(projectId).catch(() => null),
  ]);
  const live = tasks
    .filter((task) => LIVE_STATES.has(task.state))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_TASKS);
  const items = live.map((task) =>
    clip(
      `${task.id} ${task.state}: ${task.title}${task.next ? ` — next: ${task.next}` : ""}`,
    ),
  );
  if (last)
    items.push(
      clip(
        `Last session${last.date ? ` ${last.date}` : ""}: ${last.title}${last.next ? ` — next: ${last.next}` : ""}`,
      ),
    );
  if (!items.length) return null;
  const lines = [`Start brief (${projectId}):`];
  // Whole items only: one that would break the budget is left out, never cut mid-line.
  for (const item of items) {
    const candidate = [...lines, `- ${item}`].join("\n");
    if (Buffer.byteLength(candidate, "utf8") > START_BRIEF_MAX_BYTES) break;
    lines.push(`- ${item}`);
  }
  return lines.length > 1 ? lines.join("\n") : null;
}
