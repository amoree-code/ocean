import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { upgradeProfile } from "@ocean/core/domain/profiles/profile-upgrade.js";
import { atomicWrite, withFileLock } from "../../fs-utils.js";
import { oceanPath, SYSTEM_DIR } from "../../paths.js";

// The current-profile upgrade (T-245 Phase 5): dry run → manifest, apply once with a
// checksummed v1 copy of every file it replaces, rollback from that manifest. It works only
// inside the existing profile authority; it never creates a second profile root.

export type UpgradeEntry = {
  name: string;
  file: string;
  status: "current" | "upgrade" | "rejected" | "collision" | "legacy-directory";
  changes?: string[];
  issues?: string[];
  v1Sha256?: string;
  v2Sha256?: string;
  next?: string;
};

export type UpgradeManifest = {
  appliedAt: string;
  entries: {
    name: string;
    v1Sha256: string;
    v2Sha256: string;
    backup: string;
  }[];
};

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export function profilesDir(): string {
  return oceanPath(SYSTEM_DIR, "profiles");
}

// Backups and the manifest live beside the profiles, under a name no profile can have.
function upgradeDir(): string {
  return path.join(profilesDir(), ".upgrade");
}

function manifestFile(): string {
  return path.join(upgradeDir(), "manifest.json");
}

async function readManifest(): Promise<UpgradeManifest | null> {
  try {
    return JSON.parse(
      await readFile(manifestFile(), "utf8"),
    ) as UpgradeManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  return (await stat(target).catch(() => null))?.isDirectory() ?? false;
}

export async function planProfileUpgrade(): Promise<UpgradeEntry[]> {
  const dir = profilesDir();
  const names = (await readdir(dir).catch(() => [] as string[])).sort();
  const entries: UpgradeEntry[] = [];
  for (const entry of names) {
    const full = path.join(dir, entry);
    if (entry.startsWith(".")) continue;
    if (entry.endsWith(".json")) {
      const name = entry.slice(0, -".json".length);
      if (await isDirectory(path.join(dir, name))) {
        entries.push({
          name,
          file: full,
          status: "collision",
          issues: [`both ${entry} and the legacy directory ${name}/ exist`],
        });
        continue;
      }
      const source = await readFile(full, "utf8");
      let raw: unknown;
      try {
        raw = JSON.parse(source);
      } catch {
        // The parser's message quotes the file around the error; it is not repeated.
        entries.push({
          name,
          file: full,
          status: "rejected",
          issues: ["invalid JSON"],
        });
        continue;
      }
      const result = upgradeProfile(raw);
      const declared = (raw as { name?: unknown })?.name;
      if (result.status !== "rejected" && declared !== name) {
        entries.push({
          name,
          file: full,
          status: "rejected",
          issues: [`declares name "${String(declared)}", expected "${name}"`],
        });
        continue;
      }
      if (result.status === "upgrade") {
        const next = `${JSON.stringify(result.profile, null, 2)}\n`;
        entries.push({
          name,
          file: full,
          status: "upgrade",
          changes: result.changes,
          v1Sha256: sha256(source),
          v2Sha256: sha256(next),
          next,
        });
      } else if (result.status === "rejected")
        entries.push({
          name,
          file: full,
          status: "rejected",
          issues: result.issues,
        });
      else entries.push({ name, file: full, status: "current" });
    } else if ((await isDirectory(full)) && !names.includes(`${entry}.json`))
      entries.push({
        name: entry,
        file: full,
        status: "legacy-directory",
        issues: ["legacy directory profiles are not upgraded; convert by hand"],
      });
  }
  return entries;
}

// All or nothing: one rejected file or collision blocks every write. A re-run after a
// successful apply finds every profile current and writes nothing.
export async function applyProfileUpgrade(): Promise<{
  applied: string[];
  blocked: UpgradeEntry[];
}> {
  return withFileLock(manifestFile(), async () => {
    const plan = await planProfileUpgrade();
    const blocked = plan.filter(
      (entry) => entry.status === "rejected" || entry.status === "collision",
    );
    if (blocked.length) return { applied: [], blocked };
    const pending = plan.filter((entry) => entry.status === "upgrade");
    if (!pending.length) return { applied: [], blocked: [] };
    await mkdir(upgradeDir(), { recursive: true, mode: 0o700 });
    // One manifest across every apply: a later batch adds to it, so rollback still covers
    // profiles upgraded earlier. A profile upgraded again (after a rollback) replaces its entry.
    const previous = await readManifest();
    const manifest: UpgradeManifest = {
      appliedAt: new Date().toISOString(),
      entries: (previous?.entries ?? []).filter(
        (entry) => !pending.some((item) => item.name === entry.name),
      ),
    };
    // Every v1 copy is written and verified before any profile is replaced.
    for (const entry of pending) {
      const source = await readFile(entry.file, "utf8");
      if (sha256(source) !== entry.v1Sha256)
        throw new Error(
          `${entry.name} changed during the upgrade; nothing applied`,
        );
      const backup = path.join(
        upgradeDir(),
        `${entry.name}.${entry.v1Sha256?.slice(0, 12)}.v1.json`,
      );
      await atomicWrite(backup, source, 0o600);
      if (sha256(await readFile(backup, "utf8")) !== entry.v1Sha256)
        throw new Error(
          `backup of ${entry.name} did not verify; nothing applied`,
        );
      manifest.entries.push({
        name: entry.name,
        v1Sha256: entry.v1Sha256 as string,
        v2Sha256: entry.v2Sha256 as string,
        backup: path.basename(backup),
      });
    }
    await atomicWrite(
      manifestFile(),
      `${JSON.stringify(manifest, null, 2)}\n`,
      0o600,
    );
    for (const entry of pending)
      await atomicWrite(entry.file, entry.next as string, 0o600);
    return { applied: pending.map((entry) => entry.name), blocked: [] };
  });
}

// Restores each v1 copy, but only over a file still exactly as the upgrade wrote it; a
// profile edited since then is reported and left alone.
export async function rollbackProfileUpgrade(): Promise<{
  restored: string[];
  skipped: { name: string; reason: string }[];
}> {
  return withFileLock(manifestFile(), async () => {
    const manifest = await readManifest();
    if (!manifest) throw new Error("No profile upgrade to roll back");
    const restored: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const entry of manifest.entries) {
      const file = path.join(profilesDir(), `${entry.name}.json`);
      const current = await readFile(file, "utf8").catch(() => null);
      if (current === null || sha256(current) === entry.v1Sha256) {
        if (current !== null) restored.push(entry.name);
        else
          skipped.push({ name: entry.name, reason: "profile file is missing" });
        continue;
      }
      if (sha256(current) !== entry.v2Sha256) {
        skipped.push({ name: entry.name, reason: "edited since the upgrade" });
        continue;
      }
      const backup = await readFile(
        path.join(upgradeDir(), entry.backup),
        "utf8",
      );
      if (sha256(backup) !== entry.v1Sha256) {
        skipped.push({ name: entry.name, reason: "backup does not verify" });
        continue;
      }
      await atomicWrite(file, backup, 0o600);
      restored.push(entry.name);
    }
    return { restored, skipped };
  });
}

// Loads every profile the way a run would and reports each failure by name. Messages are
// validation errors, which name fields, never values from a credential check.
export async function validateProfiles(
  load: (name: string) => Promise<{ schemaVersion: number }>,
): Promise<
  { name: string; ok: boolean; schemaVersion?: number; error?: string }[]
> {
  const dir = profilesDir();
  const names = new Set<string>();
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    if (entry.startsWith(".")) continue;
    if (entry.endsWith(".json")) names.add(entry.slice(0, -".json".length));
    else if (await isDirectory(path.join(dir, entry))) names.add(entry);
  }
  const results = [];
  for (const name of [...names].sort()) {
    try {
      const profile = await load(name);
      results.push({ name, ok: true, schemaVersion: profile.schemaVersion });
    } catch (error) {
      results.push({ name, ok: false, error: (error as Error).message });
    }
  }
  return results;
}
