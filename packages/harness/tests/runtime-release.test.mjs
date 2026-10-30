import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  engineRoot,
  liveEngineEntry,
  oceanRoot,
  registerEngineRoot,
  releaseWorkspace,
  repoRoot,
} from "@ocean/core/shared/paths.js";
import {
  defaultSteps,
  releaseRoot,
  releaseRuntime,
  releaseStatus,
  useRelease,
} from "../dist/application/release/runtime-release.js";

// Releases are exported with git; an image without it (the docker gate) cannot run these.
const noGit = spawnSync("git", ["--version"]).status !== 0;

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// A throwaway OCEAN_ROOT and a tiny kernel checkout with one commit on main.
async function withWorkspace(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-release-"));
  const checkout = path.join(root, "kernel");
  await mkdir(checkout, { recursive: true });
  git(checkout, "init", "--quiet", "--initial-branch", "main");
  await writeFile(path.join(checkout, "README.md"), "kernel\n");
  git(checkout, "add", ".");
  git(
    checkout,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "--quiet",
    "--no-verify",
    "-m",
    "one",
  );
  const saved = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await run({ root, checkout });
  } finally {
    if (saved === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = saved;
    await rm(root, { recursive: true, force: true });
  }
}

// The real export; a stand-in build that writes the entry; a smoke check that it exists.
const steps = (calls, { failBuild = false } = {}) => ({
  exportTree: defaultSteps.exportTree,
  build: async (directory) => {
    calls.push("build");
    if (failBuild) throw new Error("build failed");
    const dist = path.join(directory, "packages", "harness", "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(path.join(dist, "main.js"), "// built\n");
  },
  smoke: async (entry) => {
    calls.push("smoke");
    if (!existsSync(entry)) throw new Error(`no entry ${entry}`);
  },
});

test("a release exports, builds and starts origin/main's tree, then becomes current", {
  skip: noGit,
}, async () => {
  await withWorkspace(async ({ checkout }) => {
    const calls = [];
    const first = await releaseRuntime({
      checkout,
      ref: "HEAD",
      steps: steps(calls),
    });
    assert.equal(first.id, git(checkout, "rev-parse", "--short=12", "HEAD"));
    assert.equal(first.built, true);
    assert.ok(
      existsSync(path.join(first.directory, "README.md")),
      "tree exported",
    );
    assert.equal(await readlink(path.join(releaseRoot(), "current")), first.id);
    assert.equal(
      (await releaseStatus()).entry,
      path.join(
        releaseRoot(),
        "current",
        "packages",
        "harness",
        "dist",
        "main.js",
      ),
    );
    // The same commit again is not rebuilt.
    const again = await releaseRuntime({
      checkout,
      ref: "HEAD",
      steps: steps(calls),
    });
    assert.equal(again.built, false);
    assert.equal(calls.filter((call) => call === "build").length, 1);
  });
});

test("a failed build leaves current where it was and no partial tree behind", {
  skip: noGit,
}, async () => {
  await withWorkspace(async ({ checkout }) => {
    const good = await releaseRuntime({
      checkout,
      ref: "HEAD",
      steps: steps([]),
    });
    await writeFile(path.join(checkout, "NEXT.md"), "next\n");
    git(checkout, "add", ".");
    git(
      checkout,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "--quiet",
      "--no-verify",
      "-m",
      "two",
    );
    await assert.rejects(
      releaseRuntime({
        checkout,
        ref: "HEAD",
        steps: steps([], { failBuild: true }),
      }),
      /build failed/,
    );
    const failed = git(checkout, "rev-parse", "--short=12", "HEAD");
    assert.equal(existsSync(path.join(releaseRoot(), failed)), false);
    assert.equal(
      existsSync(path.join(releaseRoot(), `${failed}.partial`)),
      false,
    );
    assert.equal(await readlink(path.join(releaseRoot(), "current")), good.id);
  });
});

test("use rolls current to a built release and refuses one that is not built", {
  skip: noGit,
}, async () => {
  await withWorkspace(async ({ checkout }) => {
    const first = await releaseRuntime({
      checkout,
      ref: "HEAD",
      steps: steps([]),
    });
    await assert.rejects(useRelease("0123456789ab", steps([])), /not built/);
    await assert.rejects(useRelease("../x", steps([])), /Not a release id/);
    const used = await useRelease(first.id, steps([]));
    assert.equal(used.previous, first.id);
    assert.equal(await readlink(path.join(releaseRoot(), "current")), first.id);
  });
});

test("an engine inside a release knows its workspace, its live entry and the owner's checkout", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ocean-release-ws-"));
  const release = path.join(
    workspace,
    "bridge",
    "runtime",
    "release",
    "abc123",
    "packages",
    "harness",
  );
  assert.equal(releaseWorkspace(release), workspace);
  assert.equal(
    liveEngineEntry(release),
    path.join(
      workspace,
      "bridge",
      "runtime",
      "release",
      "current",
      "packages",
      "harness",
      "dist",
      "main.js",
    ),
  );
  // A checkout engine is reached through its own dist/.
  assert.equal(releaseWorkspace(engineRoot()), null);
  assert.equal(
    liveEngineEntry(engineRoot()),
    path.join(engineRoot(), "dist", "main.js"),
  );

  const original = engineRoot();
  const saved = process.env.OCEAN_ROOT;
  delete process.env.OCEAN_ROOT;
  try {
    registerEngineRoot(release);
    assert.equal(oceanRoot(), workspace);
    // No kernel/ next to the release: its own tree.
    assert.equal(repoRoot(), path.resolve(release, "..", ".."));
    await mkdir(path.join(workspace, "kernel"));
    // With one, task verification and repairs work against the owner's checkout.
    assert.equal(repoRoot(), path.join(workspace, "kernel"));
  } finally {
    registerEngineRoot(original);
    if (saved !== undefined) process.env.OCEAN_ROOT = saved;
    await rm(workspace, { recursive: true, force: true });
  }
});
