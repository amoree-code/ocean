import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve("../../scripts/scan-privacy.mjs");
const noGit = spawnSync("git", ["--version"]).status !== 0;
// Assembled at run time so this file does not trip the privacy scan it tests.
const LEAK = `${"pass"}${"word"} = ${"hunter2".repeat(2)}\n`;

function scan(root) {
  const run = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  const findings = run.status ? JSON.parse(run.stderr).findings : [];
  return { code: run.status, paths: findings.map((f) => f.path).sort() };
}
function repo(setup, { git = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ocean-scan-"));
  try {
    if (git) {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["config", "user.email", `t${"@"}example.test`], {
        cwd: root,
      });
      execFileSync("git", ["config", "user.name", "t"], { cwd: root });
    }
    const put = (file, text = LEAK) => {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
    };
    setup({ root, put });
    return scan(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a clean repo passes", { skip: noGit }, () => {
  assert.deepEqual(
    repo(({ put }) => put("a.txt", "hello\n")),
    {
      code: 0,
      paths: [],
    },
  );
});

test("tracked and untracked files are both scanned", { skip: noGit }, () => {
  const result = repo(({ root, put }) => {
    put("tracked.txt");
    execFileSync("git", ["add", "tracked.txt"], { cwd: root });
    put("sub/untracked.txt");
  });
  assert.equal(result.code, 1);
  assert.deepEqual(result.paths, ["sub/untracked.txt", "tracked.txt"]);
});

test("git-ignored files, node_modules, dist and lockfiles are skipped", {
  skip: noGit,
}, () => {
  const result = repo(({ put }) => {
    put(".gitignore", "secret.env\nignored-dir/\n");
    put("secret.env");
    put("ignored-dir/x.txt");
    put("node_modules/pkg/index.js");
    put("packages/a/dist/out.js");
    put("pnpm-lock.yaml");
    put("real.txt");
  });
  assert.deepEqual(result.paths, ["real.txt"]);
});

test("a tracked file deleted from disk does not crash the scan", {
  skip: noGit,
}, () => {
  const result = repo(({ root, put }) => {
    put("gone.txt", "fine\n");
    execFileSync("git", ["add", "gone.txt"], { cwd: root });
    unlinkSync(path.join(root, "gone.txt"));
    put("stay.txt", "fine\n");
  });
  assert.deepEqual(result, { code: 0, paths: [] });
});

test("a directory that is not a git repo is still scanned", () => {
  const result = repo(
    ({ put }) => {
      put("leak.txt");
      put("node_modules/x.js");
    },
    { git: false },
  );
  assert.deepEqual(result.paths, ["leak.txt"]);
});
