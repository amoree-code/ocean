import { createHash } from "node:crypto";
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
import { enginePath, oceanPath, SYSTEM_DIR } from "../../paths.js";
import { clientSkillRoots, type SkillClient } from "./core-skill-sync.js";

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

// Additive: copies the engine's core skills and any extra source folders into the hub.
// An existing hub skill is never overwritten.
export async function populateSkillHub(
  extraSources: string[] = [],
): Promise<{ added: string[]; kept: string[] }> {
  const hub = skillHubRoot();
  await mkdir(hub, { recursive: true });
  const added: string[] = [];
  const kept: string[] = [];
  for (const source of [enginePath("skills", "core"), ...extraSources]) {
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
  action: "synchronized" | "create" | "replace" | "unlink" | "failed";
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

// Gives every client a real copy of every hub skill, replacing the symlink farm. Dry run
// unless `apply`. A symlink is only unlinked (its target is untouched); a real directory
// that differs from the hub is moved into a timestamped backup, never deleted. Anything in a
// client that the hub does not name is left alone.
export async function copyClientSkills(options: {
  apply?: boolean;
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
  const names = await skillDirectories(hub);
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
        actions.push({ client, skill, action });
        if (!options.apply || action === "synchronized") continue;
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
