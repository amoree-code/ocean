import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { oceanRoot } from "@ocean/core/shared/paths.js";

// The workspace template shipped in the package (T-296 §3.9): generic charter, policies,
// templates and indexes, empty private files, and the required empty directories. Its classes
// live in MANIFEST.json and are checked by scripts/check-template-purity.mjs.
export const WORKSPACE_TEMPLATE = fileURLToPath(
  new URL("../../../templates/workspace/", import.meta.url),
);

type Manifest = { files: Record<string, "default" | "private-empty" | "keep"> };

// Copies every template file the workspace does not have yet and creates the required
// directories. A file that already exists is never replaced, so a rerun on a populated
// workspace changes nothing. `.gitkeep` files are not copied: they only keep the template's
// empty directories in git.
export async function seedWorkspaceTemplate(
  root = oceanRoot(),
  template = WORKSPACE_TEMPLATE,
): Promise<{ created: string[]; kept: string[] }> {
  const manifest = JSON.parse(
    await readFile(path.join(template, "MANIFEST.json"), "utf8"),
  ) as Manifest;
  const created: string[] = [];
  const kept: string[] = [];
  for (const [file, kind] of Object.entries(manifest.files)) {
    const target = path.join(root, ...file.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    if (kind === "keep") continue;
    try {
      await writeFile(
        target,
        await readFile(path.join(template, ...file.split("/"))),
        { flag: "wx" },
      );
      created.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      kept.push(file);
    }
  }
  return { created, kept };
}
