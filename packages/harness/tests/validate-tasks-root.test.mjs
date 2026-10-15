import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve("scripts/validate-tasks.mjs");
const task = (id) =>
  `---\nid: ${id}\ntitle: t\nstate: active\nproject: ocean\nopened: 2026-10-07\nupdated: 2026-10-07\nartifacts: []\n---\n\n## Objective\n\n## Definition of done\n\n## Next action\n\n## Verification\n\n## Blockers\n\n## Log\n`;

// The script runs from the kernel checkout and finds the workspace tasks one level up.
function validate(taskDirs) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ocean-validate-tasks-"));
  try {
    const kernel = path.join(root, "kernel");
    mkdirSync(kernel);
    for (const [dir, ids] of Object.entries(taskDirs))
      for (const id of ids) {
        mkdirSync(path.join(root, dir, id), { recursive: true });
        writeFileSync(path.join(root, dir, id, "task.md"), task(id));
      }
    return execFileSync(process.execPath, [script], {
      cwd: kernel,
      encoding: "utf8",
    }).trim();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("validate-tasks skips cleanly when there is no private workspace", () => {
  assert.equal(
    validate({}),
    "No private task workspace found; skipped task validation",
  );
});

test("validate-tasks prefers the flat layout over brain/ once the records have moved", () => {
  assert.equal(
    validate({
      "04-projects/ocean/tasks": ["T-1", "T-2", "T-3"],
      "brain/04-projects/ocean/tasks": ["T-1"],
    }),
    "Validated 3 live and 0 archived tasks",
  );
});
