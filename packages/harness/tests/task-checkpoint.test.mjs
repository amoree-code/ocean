import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkpointTask } from "../dist/application/tasks/checkpoint-task.js";

test("checkpointTask writes a durable log entry and next action to the task file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-checkpoint-"));
  try {
    const dir = path.join(root, "T-902");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "task.md");
    await writeFile(
      file,
      `---\nid: T-902\nstate: active\n---\n\n## Objective\n\nx\n\n## Log\n`,
      "utf8",
    );
    await checkpointTask("T-902", root, {
      note: "did one bounded step",
      next: "run the verifier",
      date: "2026-09-27",
    });
    const source = await readFile(file, "utf8");
    assert.match(source, /## Log\n\n- 2026-09-27 — did one bounded step/);
    assert.match(source, /## Next action\n\nrun the verifier/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpointTask rejects an empty note", async () => {
  await assert.rejects(
    checkpointTask("T-902", "/tmp", { note: "  " }),
    /requires a note/,
  );
});
