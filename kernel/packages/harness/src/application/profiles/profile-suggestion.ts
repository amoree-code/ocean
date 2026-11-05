import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  type ProfileSuggestion,
  suggestProfile,
} from "@ocean/core/domain/profiles/profile-selection.js";
import { parseFrontmatter } from "@ocean/core/shared/fs-utils.js";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { resolveTaskReference } from "@ocean/core/shared/task-reference.js";

// The profile for one task (T-296 P6): the rule-table suggestion, or the caller's explicit
// profile, which always wins. Every selection is appended to
// bridge/state/profiles/selections.jsonl, so an override is on record.

export type ProfileSelection = {
  task: string;
  profile: string;
  override: boolean;
  suggested: ProfileSuggestion;
};

function objective(body: string): string {
  const match = /^## Objective\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(body);
  return match ? match[1].trim() : "";
}

async function installedProfiles(): Promise<string[]> {
  return (await readdir(oceanPath(SYSTEM_DIR, "profiles")).catch(() => []))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length));
}

export async function selectProfileForTask(
  ref: string,
  options: { cwd?: string; override?: string } = {},
): Promise<ProfileSelection> {
  const location = await resolveTaskReference(ref, { cwd: options.cwd });
  const source = await readFile(location.file, "utf8");
  const fields = parseFrontmatter(source);
  const suggested = suggestProfile(
    {
      id: location.id,
      title: fields.title ?? "",
      kind: fields.kind ?? fields.type,
      class: fields.class,
      risk: fields.risk,
      objective: objective(source),
    },
    await installedProfiles(),
  );
  const selection: ProfileSelection = {
    task: location.id,
    profile: options.override ?? suggested.profile,
    override: Boolean(options.override),
    suggested,
  };
  const log = oceanPath(SYSTEM_DIR, "state", "profiles", "selections.jsonl");
  await mkdir(path.dirname(log), { recursive: true, mode: 0o700 });
  await appendFile(
    log,
    `${JSON.stringify({ ts: new Date().toISOString(), ...selection })}\n`,
    { mode: 0o600 },
  );
  return selection;
}
