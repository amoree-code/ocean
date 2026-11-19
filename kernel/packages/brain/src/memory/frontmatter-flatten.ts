import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "@ocean/core/shared/fs-utils.js";
import {
  BRAIN_RECORD_DIRS,
  isUnderNotes,
  oceanPath,
  PROJECTS_DIR,
  SYSTEM_DIR,
} from "@ocean/core/shared/paths.js";

// Flat frontmatter (T-314): Obsidian Properties and Bases read top-level keys only, so a record's
// `metadata:` block moves up one level. Readers already accept both shapes (parseFrontmatter
// reads keys indented up to two spaces); this is the one-time move for files written before.
// A key that is already top-level keeps its top-level value; the nested copy is dropped.

const KEY = /^([A-Za-z_][\w-]*):/;

export function flattenFrontmatter(source: string): string | null {
  const text = source.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const lines = text.slice(4, end).split("\n");
  const start = lines.findIndex((line) => /^metadata:\s*$/.test(line));
  if (start < 0) return null;
  let stop = start + 1;
  while (stop < lines.length && /^(\s+\S|\s*$)/.test(lines[stop])) stop++;
  const nested = lines
    .slice(start + 1, stop)
    .filter((line) => line.trim())
    .map((line) => line.replace(/^ {2}/, ""));
  const outside = [...lines.slice(0, start), ...lines.slice(stop)];
  const taken = new Set(
    outside.map((line) => KEY.exec(line)?.[1]).filter(Boolean),
  );
  // A nested key and the lines under it (a list, a deeper map) move or drop together.
  const moved: string[] = [];
  let keep = true;
  for (const line of nested) {
    const key = KEY.exec(line)?.[1];
    if (key) keep = !taken.has(key);
    if (keep) moved.push(line);
  }
  const block = [...lines.slice(0, start), ...moved, ...lines.slice(stop)];
  return `---\n${block.join("\n")}${text.slice(end)}`;
}

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(file)));
    else if (entry.name.endsWith(".md")) files.push(file);
  }
  return files;
}

export type FlattenResult = {
  changed: string[];
  backup: string | null;
};

// Every record area except the owner's own notes, which agents never write. Dry run unless
// `apply`; an applied run copies each original to bridge/archive first.
export async function flattenWorkspace(options: {
  apply: boolean;
  now?: Date;
}): Promise<FlattenResult> {
  const roots = [...BRAIN_RECORD_DIRS, PROJECTS_DIR];
  const changed: { relative: string; file: string; text: string }[] = [];
  for (const root of new Set(roots))
    for (const file of await markdownFiles(oceanPath(root))) {
      // The notes sit inside 02-personal: his to shape, never rewritten.
      if (isUnderNotes(file)) continue;
      const text = flattenFrontmatter(await readFile(file, "utf8"));
      if (text === null) continue;
      changed.push({
        relative: path.relative(oceanPath(), file).split(path.sep).join("/"),
        file,
        text,
      });
    }
  if (!options.apply || !changed.length)
    return { changed: changed.map((item) => item.relative), backup: null };
  const stamp = (options.now ?? new Date())
    .toISOString()
    .replace(/[-:]/g, "")
    .slice(0, 15);
  const backup = `${SYSTEM_DIR}/archive/frontmatter-flatten-${stamp}`;
  for (const item of changed) {
    const copy = oceanPath(backup, item.relative);
    await mkdir(path.dirname(copy), { recursive: true });
    await copyFile(item.file, copy);
    // The rewrite keeps the file's own permissions (records are often 0600).
    await atomicWrite(
      item.file,
      item.text,
      (await stat(item.file)).mode & 0o777,
    );
  }
  return { changed: changed.map((item) => item.relative), backup };
}
