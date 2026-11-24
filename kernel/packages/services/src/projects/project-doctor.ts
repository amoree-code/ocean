import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DAILY_DIR, oceanPath } from "@ocean/core/shared/paths.js";
import {
  nameTypos,
  nearName,
  normalizeName,
} from "@ocean/core/shared/project-names.js";
import {
  listProjectManifests,
  matchProject,
  type ProjectManifest,
  projectAliases,
  readClaudeProjects,
  suggestProjects,
} from "@ocean/core/shared/project-resolution.js";

// `ocean project doctor` (T-332): every way a project's names have drifted apart, one warning
// each, with the command or rename that fixes it. Read-only, no model.
export type NameWarning = {
  code:
    | "UNLINKED_CLAUDE_PROJECT"
    | "NAME_DUPLICATE"
    | "NAME_TYPO"
    | "NAME_SPACING"
    | "UNKNOWN_RECORD_PROJECT"
    | "PROJECT_UNREACHABLE";
  subject: string;
  message: string;
  fix: string;
};

const quote = (value: string) => JSON.stringify(value);

// The id to put in a fix: the one suggestion when there is exactly one, else a placeholder.
function fixTarget(manifests: ProjectManifest[], name: string): string {
  const ids = [...new Set(suggestProjects(manifests, name).map((s) => s.id))];
  return ids.length === 1 ? ids[0] : "<id>";
}

function linkFix(manifests: ProjectManifest[], name: string): string {
  const target = fixTarget(manifests, name);
  const link = `ocean project link ${quote(name.trim())} ${target}`;
  return target === "<id>"
    ? `${link}, or ocean project link ${quote(name.trim())} --new <category>`
    : link;
}

function claudeNameWarnings(
  manifests: ProjectManifest[],
  names: string[],
): NameWarning[] {
  const warnings: NameWarning[] = [];
  const unlinked = new Set<string>();
  for (const name of names) {
    const tidy = name.trim().replace(/\s+/g, " ");
    if (tidy !== name)
      warnings.push({
        code: "NAME_SPACING",
        subject: name,
        message: `Claude project ${quote(name)} has extra spaces`,
        fix: `rename it in Claude to ${quote(tidy)}`,
      });
    for (const [written, meant] of nameTypos(name))
      warnings.push({
        code: "NAME_TYPO",
        subject: name,
        message: `Claude project ${quote(tidy)}: "${written}" looks like "${meant}"`,
        fix: `rename it in Claude (${written} → ${meant})`,
      });
    // One unlinked warning per name: an exact repeat is the duplicate warning's job.
    if (!matchProject(manifests, name) && !unlinked.has(normalizeName(name))) {
      unlinked.add(normalizeName(name));
      warnings.push({
        code: "UNLINKED_CLAUDE_PROJECT",
        subject: name,
        message: `Claude project ${quote(tidy)} is linked to no Ocean project`,
        fix: linkFix(manifests, name),
      });
    }
  }
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++) {
      const [a, b] = [names[i], names[j]];
      if (normalizeName(a) !== normalizeName(b) && !nearName(a, b)) continue;
      const owner = matchProject(manifests, a) ?? matchProject(manifests, b);
      warnings.push({
        code: "NAME_DUPLICATE",
        subject: `${a.trim()} / ${b.trim()}`,
        message: `Claude projects ${quote(a.trim())} and ${quote(b.trim())} look like one project`,
        fix: `keep one in Claude, and link both: ocean project link ${quote(b.trim())} ${owner ?? "<id>"}`,
      });
    }
  return warnings;
}

async function markdownIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownIn(file)));
    else if (entry.name.endsWith(".md")) files.push(file);
  }
  return files;
}

// Each session record's `project`, counted: a value no project answers to is a record the start
// brief and the weekly patterns never connect to its project.
async function recordProjects(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const file of await markdownIn(oceanPath(DAILY_DIR, "sessions"))) {
    const head = (await readFile(file, "utf8").catch(() => "")).slice(0, 2000);
    if (!/^---\n[\s\S]*?^type: session$/m.test(head)) continue;
    const raw = /^project: (.*)$/m.exec(head)?.[1]?.trim() ?? "";
    let value = raw;
    try {
      value = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
    } catch {
      /* kept as written */
    }
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

const RELINK = "the records need relinking (ocean sessions relink, T-337)";

// A value that is another name for a project (an old folder name) is linked; one that names no
// project at all (a scratch folder, `kernel`) is fixed in the records, never made an alias.
function recordWarnings(
  manifests: ProjectManifest[],
  counts: Map<string, number>,
): NameWarning[] {
  const warnings: NameWarning[] = [];
  let scratch = 0;
  for (const [value, count] of counts) {
    if (matchProject(manifests, value)) continue;
    if (/^scratch-/.test(value)) {
      scratch += count;
      continue;
    }
    const target = fixTarget(manifests, value);
    warnings.push({
      code: "UNKNOWN_RECORD_PROJECT",
      subject: value,
      message: `${count} session record(s) say project ${quote(value)}, which no project knows`,
      fix:
        target === "<id>"
          ? `ocean project link ${quote(value)} <id> if it names a project, else ${RELINK}`
          : `ocean project link ${quote(value)} ${target}`,
    });
  }
  if (scratch)
    warnings.push({
      code: "UNKNOWN_RECORD_PROJECT",
      subject: "scratch-*",
      message: `${scratch} session record(s) give a scratch folder as their project`,
      fix: RELINK,
    });
  return warnings;
}

// A project with no path, no alias and no Claude project of its name: no session, CLI or
// Desktop, ever reaches it except from inside its own folder.
function unreachableWarnings(
  manifests: ProjectManifest[],
  claudeNames: string[],
): NameWarning[] {
  const named = new Set(
    claudeNames
      .map((name) => matchProject(manifests, name))
      .filter((id): id is string => Boolean(id)),
  );
  return manifests
    .filter((manifest) => {
      if (manifest.paths.length || named.has(manifest.id)) return false;
      try {
        return projectAliases(manifest).length === 0;
      } catch {
        return true;
      }
    })
    .map((manifest) => ({
      code: "PROJECT_UNREACHABLE" as const,
      subject: manifest.id,
      message: `project '${manifest.id}' has no paths and no alias, so no session reaches it`,
      fix: `ocean project link "<Claude project name>" ${manifest.id}, or ocean project bind ${manifest.id} <path> --add`,
    }));
}

export async function projectDoctor(): Promise<NameWarning[]> {
  const manifests = await listProjectManifests();
  const claudeNames = await readClaudeProjects();
  return [
    ...claudeNameWarnings(manifests, claudeNames),
    ...recordWarnings(manifests, await recordProjects()),
    ...unreachableWarnings(manifests, claudeNames),
  ];
}

export function formatNameWarnings(warnings: NameWarning[]): string {
  if (!warnings.length) return "project names: clean";
  return [
    `project names: ${warnings.length} warning(s)`,
    ...warnings.map(
      (warning) =>
        `- ${warning.code}: ${warning.message}\n  fix: ${warning.fix}`,
    ),
  ].join("\n");
}
