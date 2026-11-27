import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { profileIdentity } from "@ocean/core/domain/profiles/profile.js";
import {
  parseProfileMarkdown,
  renderProfileMarkdown,
} from "@ocean/core/domain/profiles/profile-markdown.js";
import { validateProfile } from "@ocean/core/domain/profiles/profile-validator.js";
import { atomicWrite, withFileLock } from "@ocean/core/shared/fs-utils.js";
import {
  listProfileEntries,
  profileCollisions,
  profilesDir,
} from "@ocean/core/shared/profile-files.js";

// JSON profiles → Markdown (T-338): dry run, apply once with a checksummed copy of every JSON
// file it replaces, rollback from that manifest. Same shape as the upgrade, in its own folder
// so neither manifest can overwrite the other. A profile whose identity would change (and so
// whose sessions could no longer be resumed) is reported, never migrated.

export type MigrationEntry = {
  name: string;
  file: string;
  status:
    | "migrate"
    | "markdown"
    | "rejected"
    | "collision"
    | "legacy-directory";
  issues?: string[];
  jsonSha256?: string;
  markdownSha256?: string;
  next?: string;
};

export type MigrationManifest = {
  appliedAt: string;
  entries: {
    name: string;
    jsonSha256: string;
    markdownSha256: string;
    backup: string;
  }[];
};

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

function migrateDir(): string {
  return path.join(profilesDir(), ".migrate");
}

function manifestFile(): string {
  return path.join(migrateDir(), "manifest.json");
}

async function readManifest(): Promise<MigrationManifest | null> {
  try {
    return JSON.parse(
      await readFile(manifestFile(), "utf8"),
    ) as MigrationManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// An empty body and a missing `instructions` field are the same profile.
function comparable(raw: Record<string, unknown>): Record<string, unknown> {
  const { instructions, ...rest } = raw;
  return instructions === "" || instructions === undefined
    ? rest
    : { ...rest, instructions };
}

// Messages name fields, never values: a validation error says which field, and a parse error
// is not repeated because the parser quotes the file around it.
function convert(
  name: string,
  source: string,
): { next: string } | { issues: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return { issues: ["invalid JSON"] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { issues: ["profile must be an object"] };
  const record = raw as Record<string, unknown>;
  if (record.name !== name)
    return {
      issues: [`declares name "${String(record.name)}", expected "${name}"`],
    };
  const next = renderProfileMarkdown(record);
  // The Markdown must read back as exactly the same fields, not only the same identity: the
  // loader merges these fields (with a parent's, for `extends`) before validating them.
  let back: Record<string, unknown>;
  try {
    back = parseProfileMarkdown(next, `${name}.md`);
  } catch {
    return { issues: ["the Markdown form does not read back; edit by hand"] };
  }
  if (!isDeepStrictEqual(comparable(back), comparable(record)))
    return {
      issues: [
        "the Markdown form would change the profile (instructions with surrounding whitespace?); edit by hand",
      ],
    };
  // A profile that extends another is only complete once merged, so it is not validated alone.
  if (record.extends === undefined)
    try {
      const before = profileIdentity(validateProfile(record));
      if (profileIdentity(validateProfile(back)) !== before)
        return { issues: ["identity would change; edit by hand"] };
    } catch (error) {
      return { issues: [(error as Error).message] };
    }
  return { next };
}

export async function planProfileMigration(): Promise<MigrationEntry[]> {
  const listed = await listProfileEntries();
  const collisions = new Set(profileCollisions(listed));
  const entries: MigrationEntry[] = [];
  for (const item of listed) {
    const { name, file } = item;
    if (collisions.has(name)) {
      if (!entries.some((entry) => entry.name === name))
        entries.push({
          name,
          file,
          status: "collision",
          issues: ["the profile exists in more than one form; keep one"],
        });
      continue;
    }
    if (item.format === "md") {
      entries.push({ name, file, status: "markdown" });
      continue;
    }
    if (item.format === "directory") {
      entries.push({
        name,
        file: path.dirname(file),
        status: "legacy-directory",
        issues: ["legacy directory profiles are not migrated; convert by hand"],
      });
      continue;
    }
    const source = await readFile(file, "utf8");
    const result = convert(name, source);
    if ("issues" in result)
      entries.push({ name, file, status: "rejected", issues: result.issues });
    else
      entries.push({
        name,
        file,
        status: "migrate",
        jsonSha256: sha256(source),
        markdownSha256: sha256(result.next),
        next: result.next,
      });
  }
  return entries;
}

// All or nothing, like the upgrade: one rejected file or collision blocks every write. Every
// JSON copy is written and verified before any Markdown file is written or JSON removed.
export async function applyProfileMigration(): Promise<{
  migrated: string[];
  blocked: MigrationEntry[];
}> {
  return withFileLock(manifestFile(), async () => {
    const plan = await planProfileMigration();
    const blocked = plan.filter(
      (entry) => entry.status === "rejected" || entry.status === "collision",
    );
    if (blocked.length) return { migrated: [], blocked };
    const pending = plan.filter((entry) => entry.status === "migrate");
    if (!pending.length) return { migrated: [], blocked: [] };
    await mkdir(migrateDir(), { recursive: true, mode: 0o700 });
    const previous = await readManifest();
    const manifest: MigrationManifest = {
      appliedAt: new Date().toISOString(),
      entries: (previous?.entries ?? []).filter(
        (entry) => !pending.some((item) => item.name === entry.name),
      ),
    };
    for (const entry of pending) {
      const source = await readFile(entry.file, "utf8");
      if (sha256(source) !== entry.jsonSha256)
        throw new Error(
          `${entry.name} changed during the migration; nothing applied`,
        );
      const backup = path.join(
        migrateDir(),
        `${entry.name}.${entry.jsonSha256?.slice(0, 12)}.json`,
      );
      await atomicWrite(backup, source, 0o600);
      if (sha256(await readFile(backup, "utf8")) !== entry.jsonSha256)
        throw new Error(
          `backup of ${entry.name} did not verify; nothing applied`,
        );
      manifest.entries.push({
        name: entry.name,
        jsonSha256: entry.jsonSha256 as string,
        markdownSha256: entry.markdownSha256 as string,
        backup: path.basename(backup),
      });
    }
    await atomicWrite(
      manifestFile(),
      `${JSON.stringify(manifest, null, 2)}\n`,
      0o600,
    );
    for (const entry of pending) {
      await atomicWrite(
        path.join(profilesDir(), `${entry.name}.md`),
        entry.next as string,
        0o600,
      );
      await rm(entry.file);
    }
    return { migrated: pending.map((entry) => entry.name), blocked: [] };
  });
}

// Restores each JSON copy, but only while the Markdown file is still exactly as the migration
// wrote it; a profile edited since is reported and left alone.
export async function rollbackProfileMigration(): Promise<{
  restored: string[];
  skipped: { name: string; reason: string }[];
}> {
  return withFileLock(manifestFile(), async () => {
    const manifest = await readManifest();
    if (!manifest) throw new Error("No profile migration to roll back");
    const restored: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const entry of manifest.entries) {
      const markdownFile = path.join(profilesDir(), `${entry.name}.md`);
      const jsonFile = path.join(profilesDir(), `${entry.name}.json`);
      const markdown = await readFile(markdownFile, "utf8").catch(() => null);
      const json = await readFile(jsonFile, "utf8").catch(() => null);
      if (markdown === null) {
        if (json !== null && sha256(json) === entry.jsonSha256)
          restored.push(entry.name);
        else
          skipped.push({ name: entry.name, reason: "profile file is missing" });
        continue;
      }
      if (json !== null) {
        skipped.push({ name: entry.name, reason: "a JSON file exists again" });
        continue;
      }
      if (sha256(markdown) !== entry.markdownSha256) {
        skipped.push({
          name: entry.name,
          reason: "edited since the migration",
        });
        continue;
      }
      const backup = await readFile(
        path.join(migrateDir(), entry.backup),
        "utf8",
      );
      if (sha256(backup) !== entry.jsonSha256) {
        skipped.push({ name: entry.name, reason: "backup does not verify" });
        continue;
      }
      await atomicWrite(jsonFile, backup, 0o600);
      await rm(markdownFile);
      restored.push(entry.name);
    }
    return { restored, skipped };
  });
}
