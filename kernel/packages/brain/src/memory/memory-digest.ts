import { readdir, readFile, stat } from "node:fs/promises";
import { localDate } from "@ocean/core/shared/local-date.js";
import {
  listProjectDirs,
  oceanPath,
  PERSONAL_DIR,
} from "@ocean/core/shared/paths.js";
import { readAudit } from "./memory-audit.js";
import { listCandidates } from "./memory-review.js";

// The memory reminder for /day-start (T-296 §3.10): at most five lines, each only when there is
// something to act on. It reads; it never edits a record.

const DAY = 86_400_000;

async function openConflicts(): Promise<number> {
  const text = await readFile(
    oceanPath(PERSONAL_DIR, "CONFLICTS.md"),
    "utf8",
  ).catch(() => "");
  // A conflict is a `## ` section; the template's `## <date> — <topic>` is not one.
  return text.split("\n").filter((line) => /^## (?!<)/.test(line)).length;
}

async function projectsWithoutMemory(): Promise<string[]> {
  const missing: string[] = [];
  for (const { id, dir } of listProjectDirs()) {
    const isProject = await stat(oceanPath(dir, "project.json"))
      .then(() => true)
      .catch(() => false);
    if (!isProject) continue;
    const records = await readdir(oceanPath(dir, "memory")).catch(() => []);
    if (!records.some((name) => name.endsWith(".md") && name !== "MEMORY.md"))
      missing.push(id);
  }
  return missing.sort();
}

export async function memoryDigest(options: {
  stale: boolean | null;
  now?: Date;
}): Promise<string[]> {
  const now = options.now ?? new Date();
  const lines: string[] = [];
  const conflicts = await openConflicts();
  if (conflicts)
    lines.push(
      `memory: ${conflicts} conflict(s) wait in 02-personal/CONFLICTS.md`,
    );
  const old = (await listCandidates()).filter(
    (item) => now.getTime() - Date.parse(item.created) > 3 * DAY,
  );
  if (old.length)
    lines.push(
      `memory: ${old.length} candidate(s) older than 3 days — ocean memory review`,
    );
  if (options.stale)
    lines.push("memory: search index is stale — ocean memory reindex");
  const bare = await projectsWithoutMemory();
  if (bare.length)
    lines.push(
      `memory: no records yet for ${bare.slice(0, 5).join(", ")}${bare.length > 5 ? ` (+${bare.length - 5})` : ""}`,
    );
  const yesterday = localDate(new Date(now.getTime() - DAY));
  const writes = (await readAudit()).filter(
    (entry) =>
      (entry.action === "create" || entry.action === "update") &&
      localDate(new Date(entry.ts)) === yesterday,
  );
  if (writes.length)
    lines.push(
      `memory: ${writes.length} direct write(s) yesterday — ocean memory history`,
    );
  return lines;
}
