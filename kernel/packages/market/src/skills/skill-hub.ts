import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { profileCatalog } from "@ocean/core/shared/session-profile.js";
import {
  clientSkillRoots,
  coreSkillNames,
  type SkillClient,
} from "./core-skill-sync.js";

// The hub is the one place skills live inside Ocean. Clients hold symlinks into it, so
// there is a single copy to edit and nothing drifts per client.
export function skillHubRoot(): string {
  return oceanPath(SYSTEM_DIR, "skills");
}

async function skillDirectories(root: string): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    // Follow symlinks: a client may expose another store's skills as links.
    const full = path.join(root, entry.name);
    const isDirectory = entry.isDirectory() || (await stat(full)).isDirectory();
    if (!isDirectory) continue;
    try {
      await stat(path.join(full, "SKILL.md"));
      names.push(entry.name);
    } catch {
      /* not a skill directory */
    }
  }
  return names.sort();
}

// Additive: copies skill folders from the given sources into the hub. An existing hub skill is
// never overwritten. The engine's core skills are not put here: they have one source, the
// engine, and reach the clients through `syncCoreSkills`.
export async function populateSkillHub(
  extraSources: string[] = [],
): Promise<{ added: string[]; kept: string[] }> {
  const hub = skillHubRoot();
  await mkdir(hub, { recursive: true });
  const added: string[] = [];
  const kept: string[] = [];
  for (const source of extraSources) {
    for (const name of await skillDirectories(source)) {
      const target = path.join(hub, name);
      try {
        await lstat(target);
        kept.push(name);
      } catch {
        await cp(path.join(source, name), target, {
          recursive: true,
          dereference: true,
        });
        added.push(name);
      }
    }
  }
  return { added, kept };
}

export type LinkAction = {
  client: SkillClient;
  skill: string;
  action: "linked" | "create" | "replace" | "skip";
};

// Dry run unless `apply`. Skills a client does not already have are only added with `all`:
// every extra skill costs that client always-on context. A real directory (or a link elsewhere) already at the target is
// moved into a timestamped backup under the bridge archive before the link is made.
export async function linkClientSkills(options: {
  apply?: boolean;
  all?: boolean;
  home?: string;
  hub?: string;
}): Promise<{ actions: LinkAction[]; backup: string | null }> {
  const home = options.home ?? os.homedir();
  const hub = options.hub ?? skillHubRoot();
  const backup = path.join(
    oceanPath(SYSTEM_DIR, "archive"),
    `skills-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  const actions: LinkAction[] = [];
  let backedUp = false;
  const names = await skillDirectories(hub);
  for (const client of Object.keys(clientSkillRoots) as SkillClient[]) {
    const root = clientSkillRoots[client](home);
    try {
      await stat(root);
    } catch {
      continue; // client not installed
    }
    for (const skill of names) {
      const target = path.join(root, skill);
      const wanted = path.join(hub, skill);
      let action: LinkAction["action"] = "create";
      try {
        const info = await lstat(target);
        if (
          info.isSymbolicLink() &&
          path.resolve(root, await readlink(target)) === wanted
        ) {
          action = "linked";
        } else {
          action = "replace";
        }
      } catch {
        /* absent */
      }
      if (action === "create" && !options.all) action = "skip";
      actions.push({ client, skill, action });
      if (!options.apply || action === "linked" || action === "skip") continue;
      if (action === "replace") {
        const saved = path.join(backup, client);
        await mkdir(saved, { recursive: true });
        await rename(target, path.join(saved, skill));
        backedUp = true;
      }
      await symlink(wanted, target, "dir");
    }
  }
  return { actions, backup: backedUp ? backup : null };
}

export type CopyAction = {
  client: SkillClient;
  skill: string;
  action: "synchronized" | "create" | "replace" | "unlink" | "kept" | "failed";
  error?: string;
};

// Clients that get the hub's skills as copies. Hermes manages its own bundle and curator,
// so it is left alone unless asked for by name.
export const COPY_CLIENTS: SkillClient[] = [
  "claude",
  "codex",
  "gemini",
  "hermes",
];

// Content hash of a whole skill directory: paths and bytes, so a changed script or reference
// counts as drift, not only SKILL.md.
// A symlink inside a skill is refused: copying it would either dereference into data outside
// the hub or leave a dangling link in the client, and a loop would never finish.
async function directoryHash(directory: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(current: string, prefix: string): Promise<void> {
    const entries = (await readdir(current, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const relative = path.posix.join(prefix, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink())
        throw new Error(`${relative} is a symlink inside a skill`);
      if (info.isDirectory()) await walk(full, relative);
      else hash.update(relative).update(await readFile(full));
    }
  }
  await walk(directory, "");
  return hash.digest("hex");
}

// The latest change anywhere in a skill directory, so the automatic sync can tell a copy the
// owner edited in a client (newer than the hub's) from one the hub has moved past.
async function newestChange(directory: string): Promise<number> {
  let newest = (await lstat(directory)).mtimeMs;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    newest = Math.max(
      newest,
      entry.isDirectory()
        ? await newestChange(full)
        : (await lstat(full)).mtimeMs,
    );
  }
  return newest;
}

// Gives every client a real copy of every hub skill, replacing the symlink farm. Dry run
// unless `apply`. A symlink is only unlinked (its target is untouched); a real directory
// that differs from the hub is moved into a timestamped backup, never deleted. Anything in a
// client that the hub does not name is left alone.
//
// `auto` (the session-start sync and `ocean market`): never touches what the owner made in a
// client. A copy changed there after the hub's version, or a link pointing outside the hub, is
// `kept` and left as it is; a missing hub is nothing to copy.
export async function copyClientSkills(options: {
  apply?: boolean;
  auto?: boolean;
  clients?: SkillClient[];
  home?: string;
  hub?: string;
  archive?: string;
}): Promise<{ actions: CopyAction[]; backup: string | null }> {
  const home = options.home ?? os.homedir();
  const hub = options.hub ?? skillHubRoot();
  const backup = path.join(
    options.archive ?? oceanPath(SYSTEM_DIR, "archive"),
    `skills-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  const actions: CopyAction[] = [];
  let backedUp = false;
  let names: string[];
  try {
    names = await skillDirectories(hub);
  } catch (error) {
    if (options.auto) return { actions, backup: null };
    throw error;
  }
  for (const client of options.clients ?? COPY_CLIENTS) {
    const root = clientSkillRoots[client](home);
    try {
      await stat(root);
    } catch {
      continue; // client not installed
    }
    for (const skill of names) {
      const target = path.join(root, skill);
      const source = path.join(hub, skill);
      try {
        let action: CopyAction["action"] = "create";
        let info: Awaited<ReturnType<typeof lstat>> | null = null;
        try {
          info = await lstat(target);
        } catch {
          /* absent */
        }
        const wanted = await directoryHash(source);
        let ours = false;
        if (info?.isSymbolicLink()) {
          action = "unlink";
          // A link into the hub holds nothing of its own. Any other link is moved into the
          // backup (the link itself, intact) so what it pointed at stays reachable.
          ours = path
            .resolve(root, await readlink(target))
            .startsWith(hub + path.sep);
        } else if (info) {
          action =
            info.isDirectory() && (await directoryHash(target)) === wanted
              ? "synchronized"
              : "replace";
        }
        if (
          options.auto &&
          ((action === "unlink" && !ours) ||
            (action === "replace" &&
              (await newestChange(target)) > (await newestChange(source))))
        )
          action = "kept";
        actions.push({ client, skill, action });
        if (!options.apply || action === "synchronized" || action === "kept")
          continue;
        if (action === "replace" || (action === "unlink" && !ours)) {
          const saved = path.join(backup, client);
          await mkdir(saved, { recursive: true });
          await rename(target, path.join(saved, skill));
          backedUp = true;
        } else if (action === "unlink") await rm(target);
        // Copy beside the target and rename, so a failed copy never leaves a half skill.
        const staging = path.join(root, `.${skill}.copying`);
        await rm(staging, { recursive: true, force: true });
        try {
          await cp(source, staging, { recursive: true });
          await rename(staging, target);
        } catch (error) {
          await rm(staging, { recursive: true, force: true });
          throw error;
        }
      } catch (error) {
        // One bad skill must not abort the run halfway through every client.
        actions.push({
          client,
          skill,
          action: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { actions, backup: backedUp ? backup : null };
}

// The hash of every skill in the hub, by name: taken before `ocean market uninstall` so the
// copies of a removed skill can be found in the clients afterwards.
export async function hubSkillHashes(
  hub = skillHubRoot(),
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  let names: string[] = [];
  try {
    names = await skillDirectories(hub);
  } catch {
    return hashes;
  }
  for (const name of names)
    try {
      hashes.set(name, await directoryHash(path.join(hub, name)));
    } catch {
      /* a skill with a symlink was never copied */
    }
  return hashes;
}

// Removes from every client the copies of skills that left the hub since `before` was taken.
// Only a copy still identical to the hub's version goes; one the owner changed stays.
export async function pruneClientSkills(
  before: Map<string, string>,
  options: { home?: string; hub?: string; clients?: SkillClient[] } = {},
): Promise<string[]> {
  const home = options.home ?? os.homedir();
  const now = await hubSkillHashes(options.hub);
  const removed: string[] = [];
  for (const [skill, hash] of before) {
    if (now.has(skill)) continue;
    for (const client of options.clients ?? COPY_CLIENTS) {
      const target = path.join(clientSkillRoots[client](home), skill);
      const info = await lstat(target).catch(() => null);
      if (!info?.isDirectory()) continue;
      if ((await directoryHash(target).catch(() => null)) !== hash) continue;
      await rm(target, { recursive: true, force: true });
      removed.push(`${client}:${skill}`);
    }
  }
  return removed;
}

// Hubs set up before core skills left the hub hold a copy of each, made once and never updated,
// so it drifts behind the engine. Each one moves into the bridge archive (kept, not deleted);
// a skill the marketplace installed under the same name carries its marker and stays.
export async function retireCoreFromHub(
  options: { hub?: string; archive?: string } = {},
): Promise<string[]> {
  const hub = options.hub ?? skillHubRoot();
  const archive = path.join(
    options.archive ?? oceanPath(SYSTEM_DIR, "archive"),
    `hub-core-skills-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  const moved: string[] = [];
  for (const name of await coreSkillNames()) {
    const target = path.join(hub, name);
    const info = await lstat(target).catch(() => null);
    if (!info?.isDirectory()) continue;
    if (
      await lstat(path.join(target, ".ocean-capability.json")).catch(() => null)
    )
      continue;
    await mkdir(archive, { recursive: true });
    await rename(target, path.join(archive, name));
    moved.push(name);
  }
  return moved;
}

// One check that every installed client holds the skills Ocean keeps for it (T-319 C5,
// borrowed from COG's validate-agent-surface): the engine's core skills everywhere, plus the
// hub's skills in the clients that get copies. A client with no skills folder is not installed
// and is listed, not judged. `extra` is what a client holds on its own; it is shown, not a fault.
export type SkillSurfaceReport = {
  consistent: boolean;
  clients: {
    client: SkillClient;
    root: string;
    installed: boolean;
    expected: number;
    missing: string[];
    extra: string[];
  }[];
};

export async function skillSurfaceReport(
  options: { home?: string; hub?: string } = {},
): Promise<SkillSurfaceReport> {
  const home = options.home ?? os.homedir();
  const core = await coreSkillNames();
  const hub = await skillDirectories(options.hub ?? skillHubRoot()).catch(
    () => [] as string[],
  );
  const clients = await Promise.all(
    (Object.keys(clientSkillRoots) as SkillClient[]).map(async (client) => {
      const root = clientSkillRoots[client](home);
      const expected = new Set(
        COPY_CLIENTS.includes(client) ? [...core, ...hub] : core,
      );
      let held: string[] | null;
      try {
        held = await skillDirectories(root);
      } catch {
        held = null;
      }
      const present = new Set(held ?? []);
      return {
        client,
        root,
        installed: held !== null,
        expected: expected.size,
        missing: held
          ? [...expected].filter((name) => !present.has(name)).sort()
          : [],
        extra: (held ?? []).filter((name) => !expected.has(name)),
      };
    }),
  );
  return {
    consistent: clients.every((row) => !row.installed || !row.missing.length),
    clients,
  };
}

export type SkillProfileReport = {
  // False when a profile names a skill nobody holds; a skill in no profile, or held only by
  // a client, only warns.
  consistent: boolean;
  profiles: number;
  // Hub skills no profile lists: each is adopted into a profile or archived (T-338 P3).
  noProfile: string[];
  // A profile naming a skill that is neither core, in the hub, nor held by any client.
  missing: { profile: string; skill: string }[];
  // A profile naming a skill a client ships itself (xlsx, pdf, ...), not core or the hub.
  clientOnly: { profile: string; skill: string }[];
  // A profile that does not load.
  problems: { name: string; error: string }[];
};

// Skill names any client holds, nested folders included (Claude's synced/<id>/<skill>,
// hermes' <category>/<skill>), to a bounded depth.
export async function clientHeldSkills(
  home = os.homedir(),
  depth = 4,
): Promise<Set<string>> {
  const names = new Set<string>();
  const walk = async (dir: string, left: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      const isDirectory =
        entry.isDirectory() ||
        (entry.isSymbolicLink() &&
          (await stat(full).then(
            (s) => s.isDirectory(),
            () => false,
          )));
      if (!isDirectory) continue;
      if (
        await stat(path.join(full, "SKILL.md")).then(
          () => true,
          () => false,
        )
      )
        names.add(entry.name);
      else if (left > 1) await walk(full, left - 1);
    }
  };
  for (const root of Object.values(clientSkillRoots))
    await walk(root(home), depth);
  return names;
}

// Every hub skill belongs to at least one profile, and no profile names a skill nobody holds.
export async function skillProfileReport(
  options: { hub?: string; home?: string } = {},
): Promise<SkillProfileReport> {
  const core = new Set(await coreSkillNames());
  const hub = await skillDirectories(options.hub ?? skillHubRoot()).catch(
    () => [] as string[],
  );
  const known = new Set([...core, ...hub]);
  const catalog = await profileCatalog();
  const listed = new Set<string>();
  const unknown: SkillProfileReport["missing"] = [];
  for (const profile of catalog.profiles)
    for (const skill of profile.skills) {
      listed.add(skill);
      if (!known.has(skill)) unknown.push({ profile: profile.name, skill });
    }
  const held = unknown.length
    ? await clientHeldSkills(options.home)
    : new Set<string>();
  const missing = unknown.filter(({ skill }) => !held.has(skill));
  return {
    consistent: !missing.length && !catalog.problems.length,
    profiles: catalog.profiles.length,
    noProfile: hub.filter((name) => !listed.has(name)).sort(),
    missing,
    clientOnly: unknown.filter(({ skill }) => held.has(skill)),
    problems: catalog.problems,
  };
}
