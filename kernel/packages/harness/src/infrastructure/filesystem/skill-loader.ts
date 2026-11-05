import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  type Skill,
  type SkillIndexEntry,
  type SkillMetadata,
  skillMetadataSchema,
} from "@ocean/core/domain/skills/skill.js";
import { validateSkill } from "@ocean/core/domain/skills/skill-validator.js";
import {
  enginePath,
  oceanPath,
  oceanRoot,
  PROJECTS_DIR,
  SYSTEM_DIR,
} from "@ocean/core/shared/paths.js";

const catalogPath = enginePath("skills", "index.json");

export async function listSkills(): Promise<SkillMetadata[]> {
  return readCatalog(catalogPath);
}

export async function loadSkill(name: string): Promise<Skill> {
  const { metadata, file } = await resolveSkillFile(name, [
    enginePath("skills"),
  ]);
  return validateSkill({
    ...metadata,
    instructions: await readFile(file, "utf8"),
  });
}

// Resolves profile skills to catalog metadata plus their SKILL.md path, in order and
// deduplicated, without reading any body. The description comes from index.json.
export async function loadSkillIndex(
  names: string[],
  cwd = oceanRoot(),
): Promise<SkillIndexEntry[]> {
  const roots = skillRoots(cwd);
  const entries: SkillIndexEntry[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const { metadata, file } = await resolveSkillFile(name, roots);
    entries.push({ ...metadata, path: file });
  }
  return entries;
}

function skillRoots(cwd: string): string[] {
  return [
    enginePath("skills"),
    oceanPath(SYSTEM_DIR, "integrations", "claude-code", "skills"),
    projectSkillRoot(cwd),
  ].filter(Boolean) as string[];
}

// The first root whose index.json lists the skill and whose SKILL.md exists wins.
async function resolveSkillFile(
  name: string,
  roots: string[],
): Promise<{ metadata: SkillMetadata; file: string }> {
  for (const root of roots) {
    const catalog = path.join(root, "index.json");
    try {
      const metadata = (await readCatalog(catalog)).find(
        (skill) => skill.name === name,
      );
      if (!metadata) continue;
      const file = path.join(root, metadata.category, name, "SKILL.md");
      await stat(file);
      return { metadata, file };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  throw new Error(`Skill not found: ${name}`);
}

async function readCatalog(file: string): Promise<SkillMetadata[]> {
  try {
    return skillMetadataSchema
      .array()
      .parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function projectSkillRoot(cwd: string): string | null {
  const projectsRoot = path.resolve(oceanPath(PROJECTS_DIR));
  const relative = path.relative(projectsRoot, path.resolve(cwd));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    return null;
  const parts = relative.split(path.sep);
  const grouped = [
    "work",
    "freelance",
    "personal",
    "vendor",
    "archive",
  ].includes(parts[0] ?? "");
  const projectParts = grouped ? parts.slice(0, 2) : parts.slice(0, 1);
  return path.join(projectsRoot, ...projectParts, "skills");
}
