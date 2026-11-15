import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  RECORD_TYPES,
  recordFolder,
} from "@ocean/brain/memory/fact-routing.js";
import { redactSecrets } from "@ocean/core/domain/redaction/redaction.js";
import { atomicWrite } from "@ocean/core/shared/fs-utils.js";
import {
  INBOX_DIR,
  oceanPath,
  TEMPLATES_DIR,
} from "@ocean/core/shared/paths.js";
import { projectSlug } from "@ocean/core/shared/project-resolution.js";

// T-314 capture and templates. Obsidian is the view of the same files, so a new note made in a
// type's folder should start from that type's template: Templater's folder templates are
// generated from routing.json instead of being kept by hand.

export type FolderTemplate = { folder: string; template: string };

const TEMPLATER_CONFIG = [
  ".obsidian",
  "plugins",
  "templater-obsidian",
  "data.json",
];

async function exists(file: string): Promise<boolean> {
  return readFile(file).then(
    () => true,
    () => false,
  );
}

// One entry per routed type whose template exists in 06-templates; entries the owner made for
// other folders are kept, and a routed folder's entry is replaced.
export async function planFolderTemplates(
  current: FolderTemplate[],
): Promise<{ entries: FolderTemplate[]; missing: string[] }> {
  const routed: FolderTemplate[] = [];
  const missing: string[] = [];
  for (const type of RECORD_TYPES) {
    const folder = recordFolder(type)?.replace(/\/$/, "");
    if (!folder) continue;
    const template = `${TEMPLATES_DIR}/${type}.md`;
    if (await exists(oceanPath(template))) routed.push({ folder, template });
    else missing.push(type);
  }
  const ours = new Set(routed.map((entry) => entry.folder));
  return {
    entries: [...current.filter((entry) => !ours.has(entry.folder)), ...routed],
    missing,
  };
}

export async function syncFolderTemplates(options: {
  apply: boolean;
}): Promise<{
  file: string;
  entries: FolderTemplate[];
  missing: string[];
  written: boolean;
}> {
  const file = oceanPath(...TEMPLATER_CONFIG);
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(`${TEMPLATER_CONFIG.join("/")} is not valid JSON`);
  }
  const current = Array.isArray(config.folder_templates)
    ? (config.folder_templates as FolderTemplate[]).filter(
        (entry) =>
          typeof entry?.folder === "string" &&
          typeof entry?.template === "string",
      )
    : [];
  const plan = await planFolderTemplates(current);
  const relative = TEMPLATER_CONFIG.join("/");
  if (!options.apply) return { file: relative, ...plan, written: false };
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(
    file,
    `${JSON.stringify(
      {
        ...config,
        templates_folder: config.templates_folder ?? TEMPLATES_DIR,
        enable_folder_templates: true,
        folder_templates: plan.entries,
      },
      null,
      2,
    )}\n`,
  );
  return { file: relative, ...plan, written: true };
}

// A quick note from anywhere (`ocean note "<text>"`): one file in 00-inbox/captures with the
// capture frontmatter, named by time and its first words. Secrets are redacted before writing.
export async function writeCapture(
  text: string,
  now = new Date(),
): Promise<string> {
  const body = redactSecrets(text.trim());
  if (!body) throw new Error('Usage: ocean note "<text>"');
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15);
  const slug =
    projectSlug(body.split(/\s+/).slice(0, 6).join(" ")).slice(0, 40) || "note";
  const relative = `${INBOX_DIR}/captures/${stamp}-${slug}.md`;
  const file = oceanPath(relative);
  await mkdir(path.dirname(file), { recursive: true });
  if (await exists(file)) throw new Error(`${relative} already exists`);
  const title = body.split("\n")[0].slice(0, 80);
  await atomicWrite(
    file,
    `---\ntype: capture\ncreated: ${now.toISOString()}\nsource: cli\ntags: []\n---\n\n# ${title}\n\n${body}\n`,
  );
  return relative;
}
