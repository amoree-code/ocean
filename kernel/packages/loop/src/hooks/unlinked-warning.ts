import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWrite, truncateUtf8 } from "@ocean/core/shared/fs-utils.js";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { normalizeName } from "@ocean/core/shared/project-names.js";
import {
  listProjectManifests,
  type ProjectResolution,
  suggestProjects,
} from "@ocean/core/shared/project-resolution.js";

// One line at session start when the folder (or, from P3, the Claude project) a session runs in
// is linked to no project (T-332): bounded, and said at most once per name per day, so it is a
// nudge and never noise. The full list, with every fix, is `ocean project doctor`.
export const UNLINKED_WARNING_MAX_BYTES = 120;

export function unlinkedWarnedFile(): string {
  return oceanPath(SYSTEM_DIR, "state", "projects", "unlinked-warned.json");
}

const day = (now: Date) => now.toISOString().slice(0, 10);

// True the first time `name` is seen on this day, and records it; false after that. Only the
// current day's names are kept. An unreadable state file reads as empty: one repeat at worst.
export async function firstTodayFor(
  name: string,
  now: Date = new Date(),
): Promise<boolean> {
  const file = unlinkedWarnedFile();
  const today = day(now);
  let seen: Record<string, string> = {};
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object")
      seen = Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => value === today),
      );
  } catch {
    /* none yet */
  }
  const key = normalizeName(name);
  if (seen[key]) return false;
  seen[key] = today;
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, `${JSON.stringify(seen, null, 2)}\n`);
  return true;
}

export function unlinkedLine(name: string, fix: string): string {
  return truncateUtf8(
    `Ocean: ${JSON.stringify(name)} is linked to no project → ${fix}`,
    UNLINKED_WARNING_MAX_BYTES,
  );
}

const tilde = (dir: string) => {
  const home = os.homedir();
  return dir === home || dir.startsWith(`${home}${path.sep}`)
    ? `~${dir.slice(home.length)}`
    : dir;
};

// An unbound session in a git repo: name the repo and the bind that links it. A scratch folder
// or the home directory has no git root and gets nothing. Best-effort, never throws.
export async function unlinkedFolderWarning(
  project: ProjectResolution,
  now: Date = new Date(),
): Promise<string | null> {
  try {
    if (project.status !== "unbound" || !project.gitRoot) return null;
    const name = path.basename(project.gitRoot);
    if (!(await firstTodayFor(name, now))) return null;
    const ids = [
      ...new Set(
        suggestProjects(await listProjectManifests(), name).map((s) => s.id),
      ),
    ];
    const id = ids.length === 1 ? ids[0] : "<id>";
    const full = unlinkedLine(
      name,
      `ocean project bind ${id} ${tilde(project.gitRoot)} --add`,
    );
    const fix = `ocean project bind ${id} . --add`;
    return full.endsWith(" --add") ? full : unlinkedLine(name, fix);
  } catch {
    return null;
  }
}
