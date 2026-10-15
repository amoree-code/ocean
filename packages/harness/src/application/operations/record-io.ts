import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { readFrontmatterFile as readFrontmatterFileWithLimit } from "../../fs-utils.js";
import { oceanRoot } from "../../paths.js";
import type { Freshness } from "../context/context-packet.js";

// Bounded, deterministic Ocean record I/O (T-198 slice 7). Every read is scoped to a
// specific record directory and capped by the caller's budget — there is no repository-wide
// scan anywhere in this module. Every write is atomic (temp file + rename, see fs-utils.ts)
// and refuses to run without an explicit, matching approval.

const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
// Hard structural caps, independent of the caller's budget: a directory walk can never
// examine more than this, whatever budget is passed.
const MAX_SCAN_ENTRIES = 200;
const MAX_SCAN_DEPTH = 3;
export const FRONTMATTER_READ_BYTES = 4_096;

export function freshnessFor(mtimeMs: number): Freshness {
  return Date.now() - mtimeMs <= STALE_AFTER_MS ? "current" : "stale";
}

export async function readFrontmatterFile(
  file: string,
): ReturnType<typeof readFrontmatterFileWithLimit> {
  return readFrontmatterFileWithLimit(file, FRONTMATTER_READ_BYTES);
}

// Depth-limited, entry-capped listing of one record directory. Never recurses outside the
// directory it was given and never returns more than MAX_SCAN_ENTRIES paths.
export async function listRecordFiles(
  root: string,
  depth = 0,
  budgetLeft = { entries: MAX_SCAN_ENTRIES },
): Promise<string[]> {
  if (depth > MAX_SCAN_DEPTH || budgetLeft.entries <= 0) return [];
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (budgetLeft.entries <= 0) break;
    if (entry.name.startsWith(".")) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRecordFiles(full, depth + 1, budgetLeft)));
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    budgetLeft.entries -= 1;
    files.push(full);
  }
  return files;
}

export function relativeToOcean(file: string): string {
  return path.relative(oceanRoot(), file).split(path.sep).join("/");
}

export async function requireAbsentTarget(
  target: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await stat(target);
    return {
      ok: false,
      reason: `refusing to overwrite an existing record at ${relativeToOcean(target)}`,
    };
  } catch {
    return { ok: true };
  }
}
