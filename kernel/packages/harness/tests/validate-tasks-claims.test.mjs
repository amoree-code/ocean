import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve("scripts/validate-tasks.mjs");
const hoursAgo = (hours) =>
  new Date(Date.now() - hours * 3_600_000).toISOString();
const task = (id, extra = "", state = "active") =>
  `---\nid: ${id}\ntitle: t\nstate: ${state}\nproject: ocean\nopened: 2026-10-07\nupdated: 2026-10-07\nartifacts: []\n${extra}---\n\n## Objective\n\n## Definition of done\n\n## Next action\n\n## Verification\n\n## Blockers\n\n## Log\n`;

// tasks: { T-1: "claimed_by: a\nclaimed_at: ...\n" } — extra frontmatter per task.
function validate(tasks, state) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ocean-validate-claims-"));
  try {
    const kernel = path.join(root, "kernel");
    mkdirSync(kernel);
    for (const [id, extra] of Object.entries(tasks)) {
      const dir = path.join(root, "04-projects/ocean/tasks", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "task.md"), task(id, extra, state));
    }
    const run = spawnSync(process.execPath, [script], {
      cwd: kernel,
      encoding: "utf8",
    });
    return { code: run.status, out: run.stdout, err: run.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const claim = (by, at, paths) =>
  `claimed_by: ${by}\nclaimed_at: ${at}\n${paths ? `claimed_paths: ${paths}\n` : ""}`;

test("a fresh, well-formed claim passes without a warning", () => {
  const run = validate({ "T-1": claim("sess-a", hoursAgo(0.1), "[kernel]") });
  assert.equal(run.code, 0);
  assert.equal(run.err, "");
});

test("a claim older than two hours is stale: warned, not an error", () => {
  const run = validate({ "T-1": claim("sess-a", hoursAgo(3)) });
  assert.equal(run.code, 0);
  assert.match(run.err, /stale claim by sess-a/);
});

test("claimed_by without claimed_at is an error", () => {
  const run = validate({ "T-1": "claimed_by: sess-a\n" });
  assert.equal(run.code, 1);
  assert.match(run.err, /needs both claimed_by and claimed_at/);
});

test("claimed_at that is not an ISO timestamp is an error", () => {
  const run = validate({ "T-1": claim("sess-a", "yesterday") });
  assert.equal(run.code, 1);
  assert.match(run.err, /not an ISO-8601 timestamp/);
});

test("claimed_paths must be an inline list", () => {
  const run = validate({ "T-1": claim("sess-a", hoursAgo(0.1), "kernel") });
  assert.equal(run.code, 1);
  assert.match(run.err, /claimed_paths must be an inline list/);
});

test("different owners claiming overlapping paths is an error", () => {
  const run = validate({
    "T-1": claim("sess-a", hoursAgo(0.1), "[packages/harness]"),
    "T-2": claim("sess-b", hoursAgo(0.2), "[packages/harness/src, docs]"),
  });
  assert.equal(run.code, 1);
  assert.match(run.err, /claim conflict on packages\/harness/);
});

test("paths that only share a prefix string do not overlap", () => {
  const run = validate({
    "T-1": claim("sess-a", hoursAgo(0.1), "[packages/harness]"),
    "T-2": claim("sess-b", hoursAgo(0.2), "[packages/harness-extra]"),
  });
  assert.equal(run.code, 0);
});

test("the same owner may hold overlapping paths on two tasks", () => {
  const run = validate({
    "T-1": claim("sess-a", hoursAgo(0.1), "[kernel]"),
    "T-2": claim("sess-a", hoursAgo(0.2), "[kernel/docs]"),
  });
  assert.equal(run.code, 0);
});

test("a stale claim does not conflict with a live one", () => {
  const run = validate({
    "T-1": claim("sess-a", hoursAgo(5), "[kernel]"),
    "T-2": claim("sess-b", hoursAgo(0.2), "[kernel]"),
  });
  assert.equal(run.code, 0);
  assert.match(run.err, /stale claim by sess-a/);
});

test("a finished task that is still claimed is warned about", () => {
  const run = validate({ "T-1": claim("sess-a", hoursAgo(0.1)) }, "done");
  assert.equal(run.code, 0);
  assert.match(run.err, /still claimed by sess-a/);
});
