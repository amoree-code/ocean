import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { oceanPath, SYSTEM_DIR } from "./paths.js";

// Where profiles live and which files are profiles (T-338). One root; a profile is
// `<name>.md` (Markdown, frontmatter + instructions body), `<name>.json`, or a legacy
// `<name>/profile.json` directory. Every reader lists them through here, so a new form or root
// is one change, not one per caller.

export type ProfileFormat = "md" | "json" | "directory";
export type ProfileEntry = {
  name: string;
  file: string;
  format: ProfileFormat;
};

// The same rule as a profile name: other files in the root (a README, `.upgrade/`) are not
// profiles.
const profileName = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function profilesDir(): string {
  return oceanPath(SYSTEM_DIR, "profiles");
}

// Every profile form in the root, sorted by name. A name present in more than one form appears
// once per form, so a caller can report the collision.
export async function listProfileEntries(
  dir: string = profilesDir(),
): Promise<ProfileEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: ProfileEntry[] = [];
  for (const entry of names) {
    const full = path.join(dir, entry);
    const extension = path.extname(entry);
    const name = path.basename(entry, extension);
    if (!profileName.test(name)) continue;
    if (extension === ".md" || extension === ".json") {
      if ((await stat(full).catch(() => null))?.isFile())
        entries.push({
          name,
          file: full,
          format: extension === ".md" ? "md" : "json",
        });
    } else if (
      !extension &&
      (await stat(path.join(full, "profile.json")).catch(() => null))?.isFile()
    )
      entries.push({
        name,
        file: path.join(full, "profile.json"),
        format: "directory",
      });
  }
  return entries.sort(
    (a, b) => a.name.localeCompare(b.name) || a.format.localeCompare(b.format),
  );
}

export async function listProfileNames(
  dir: string = profilesDir(),
): Promise<string[]> {
  return [...new Set((await listProfileEntries(dir)).map((e) => e.name))];
}

// Names present in more than one form: which file is the profile would be ambiguous.
export function profileCollisions(entries: ProfileEntry[]): string[] {
  const seen = new Map<string, number>();
  for (const entry of entries)
    seen.set(entry.name, (seen.get(entry.name) ?? 0) + 1);
  return [...seen].filter(([, count]) => count > 1).map(([name]) => name);
}
