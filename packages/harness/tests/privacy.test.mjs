import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function scan(root) {
  const child = spawn(
    process.execPath,
    [path.join(process.cwd(), "..", "..", "scripts", "scan-privacy.mjs"), root],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
test("privacy scanner fails without printing secret values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-privacy-"));
  const secret = ["sk-ant", "test-value-that-must-not-be-printed"].join("-");
  await writeFile(path.join(root, "bad.txt"), secret);
  const result = await scan(root);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /credential/);
  assert.doesNotMatch(result.stderr, new RegExp(secret));
});
test("privacy scanner ignores license text and generated directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-privacy-clean-"));
  await mkdir(path.join(root, "dist"));
  await writeFile(
    path.join(root, "LICENSE"),
    `Copyright 2026 Example <${["legal", "example.com"].join("@")}>`,
  );
  await writeFile(
    path.join(root, "dist", "bundle.js"),
    `const token = '${["sk-ant", "generated-value-ignored"].join("-")}';`,
  );
  const result = await scan(root);
  assert.equal(result.code, 0);
});

test("privacy scanner catches generic bearer and key assignments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-privacy-generic-"));
  await writeFile(
    path.join(root, "bad.txt"),
    `Authorization: Bearer ${"a".repeat(24)}\napi_key=${"b".repeat(16)}`,
  );
  const result = await scan(root);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /credential/);
  assert.doesNotMatch(result.stderr, /a{24}|b{16}/);
});
test("privacy scanner ignores the .git file a linked worktree has instead of a directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-privacy-worktree-"));
  await writeFile(
    path.join(root, ".git"),
    `gitdir: ${["", "Users", "someone", "repo"].join("/")}/.git/worktrees/example\n`,
  );
  const result = await scan(root);
  assert.equal(result.code, 0, result.stderr);
});
