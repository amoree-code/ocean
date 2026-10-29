import { execFile as execFileCallback, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readlink, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { oceanPath, repoRoot, SYSTEM_DIR } from "@ocean/core/shared/paths.js";

const execFile = promisify(execFileCallback);

// Sessions run the engine through shims and hooks; when those point into the kernel checkout,
// every development build (any branch) becomes what every session runs — on 2026-10-26 unmerged
// code rewrote real client configs, on 2026-10-27 a stale build dropped a module the session
// start needed (T-294). A release is origin/main exported, installed and built under
// bridge/runtime/release/<sha>; `current` is repointed only after the build proves it starts.

export type ReleaseSteps = {
  // Writes the tree of `ref` from the checkout into `target` (an empty directory).
  exportTree: (checkout: string, ref: string, target: string) => Promise<void>;
  // Installs and builds the exported tree in place; throws on failure.
  build: (directory: string) => Promise<void>;
  // Runs the built entry once; throws unless it starts.
  smoke: (entry: string) => Promise<void>;
};

export type ReleaseResult = {
  id: string;
  directory: string;
  built: boolean;
  previous: string | null;
  current: string;
};

export function releaseRoot(): string {
  return oceanPath(SYSTEM_DIR, "runtime", "release");
}

const entryOf = (directory: string) =>
  path.join(directory, "packages", "harness", "dist", "main.js");

async function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  await execFile(command, args, {
    cwd,
    timeout: 900_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

export const defaultSteps: ReleaseSteps = {
  exportTree: (checkout, ref, target) =>
    new Promise((resolve, reject) => {
      const archive = spawn("git", ["-C", checkout, "archive", ref], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      const tar = spawn("tar", ["-x", "-C", target], {
        stdio: ["pipe", "inherit", "inherit"],
      });
      archive.stdout.pipe(tar.stdin);
      // Settle only once both have closed: tar can close before git's own close event fires.
      const codes: { git?: number | null; tar?: number | null } = {};
      const settle = () => {
        if (!("git" in codes) || !("tar" in codes)) return;
        if (codes.git === 0 && codes.tar === 0) resolve();
        else
          reject(
            new Error(
              `export of ${ref} failed (git ${codes.git}, tar ${codes.tar})`,
            ),
          );
      };
      archive.on("error", reject);
      tar.on("error", reject);
      archive.on("close", (code) => {
        codes.git = code;
        settle();
      });
      tar.on("close", (code) => {
        codes.tar = code;
        settle();
      });
    }),
  build: async (directory) => {
    await run(
      "pnpm",
      ["install", "--frozen-lockfile", "--prefer-offline"],
      directory,
    );
    await run("pnpm", ["build"], directory);
  },
  smoke: (entry) =>
    run(process.execPath, [entry, "--version"], path.dirname(entry)),
};

async function currentTarget(): Promise<string | null> {
  try {
    return await readlink(path.join(releaseRoot(), "current"));
  } catch {
    return null;
  }
}

// Points `current` at `id` atomically: a new link is renamed over the old one.
async function pointCurrent(id: string): Promise<void> {
  const link = path.join(releaseRoot(), "current");
  const next = `${link}.next`;
  await rm(next, { force: true });
  await symlink(id, next);
  await rename(next, link);
}

export async function releaseStatus(): Promise<{
  current: string | null;
  entry: string | null;
}> {
  const current = await currentTarget();
  return {
    current,
    entry: current ? entryOf(path.join(releaseRoot(), "current")) : null,
  };
}

// Builds origin/main of the kernel checkout (unless that commit is already built) and makes
// it current. A failed export, build or start leaves `current` where it was.
export async function releaseRuntime(
  options: { checkout?: string; ref?: string; steps?: ReleaseSteps } = {},
): Promise<ReleaseResult> {
  const checkout = options.checkout ?? repoRoot();
  const ref = options.ref ?? "origin/main";
  const steps = options.steps ?? defaultSteps;
  if (ref === "origin/main")
    await run(
      "git",
      ["-C", checkout, "fetch", "--quiet", "origin", "main"],
      checkout,
    );
  const { stdout } = await execFile("git", [
    "-C",
    checkout,
    "rev-parse",
    "--short=12",
    `${ref}^{commit}`,
  ]);
  const id = stdout.trim();
  const directory = path.join(releaseRoot(), id);
  let built = false;
  if (!existsSync(entryOf(directory))) {
    const partial = `${directory}.partial`;
    await rm(partial, { recursive: true, force: true });
    await mkdir(partial, { recursive: true });
    try {
      await steps.exportTree(checkout, ref, partial);
      await steps.build(partial);
      await steps.smoke(entryOf(partial));
    } catch (error) {
      await rm(partial, { recursive: true, force: true });
      throw error;
    }
    await rm(directory, { recursive: true, force: true });
    await rename(partial, directory);
    built = true;
  }
  await steps.smoke(entryOf(directory));
  const previous = await currentTarget();
  await pointCurrent(id);
  return { id, directory, built, previous, current: id };
}

// Rolls `current` back (or forward) to a release that is already built.
export async function useRelease(
  id: string,
  steps: Pick<ReleaseSteps, "smoke"> = defaultSteps,
): Promise<ReleaseResult> {
  if (!/^[0-9a-f]{7,40}$/.test(id)) throw new Error(`Not a release id: ${id}`);
  const directory = path.join(releaseRoot(), id);
  if (!existsSync(entryOf(directory)))
    throw new Error(`Release ${id} is not built in ${releaseRoot()}`);
  await steps.smoke(entryOf(directory));
  const previous = await currentTarget();
  await pointCurrent(id);
  return { id, directory, built: false, previous, current: id };
}
