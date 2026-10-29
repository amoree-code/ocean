import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { repoRoot } from "@ocean/core/shared/paths.js";

const guard = path.join(repoRoot(), "scripts", "no-commit-on-main.mjs");

const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });

async function repoOn(branch) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ocean-no-main-"));
  git(cwd, "init", "--quiet", "--initial-branch", branch);
  return cwd;
}

const run = (cwd) =>
  spawnSync(process.execPath, [guard], { cwd, encoding: "utf8" });

test("a commit on main is refused with the way out", async () => {
  const result = run(await repoOn("main"));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to commit on main/);
});

test("a feature branch and a detached HEAD may commit", async () => {
  assert.equal(run(await repoOn("feat/t1-x")).status, 0);
  const cwd = await repoOn("main");
  git(
    cwd,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "--quiet",
    "--allow-empty",
    "--no-verify",
    "-m",
    "x",
  );
  git(cwd, "checkout", "--quiet", "--detach");
  assert.equal(run(cwd).status, 0);
});

test("lefthook runs the guard before every commit", async () => {
  const { readFile } = await import("node:fs/promises");
  const config = await readFile(path.join(repoRoot(), "lefthook.yml"), "utf8");
  assert.match(
    config,
    /no-main:\s*\n\s*run: node scripts\/no-commit-on-main\.mjs/,
  );
});
