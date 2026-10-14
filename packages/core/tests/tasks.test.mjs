import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PROJECTS_DIR } from "../dist/paths.js";

function validate(root) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(process.cwd(), "scripts", "validate-tasks.mjs"), root],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}
const task = (id, state, checklist = "[x]") =>
  `---\nid: ${id}\ntitle: Test\nstate: ${state}\nproject: test\ngoal: Test\nreferences: [T-001]\n---\n\nchecklist:\n  - "${checklist} work"\n`;

test("task validator accepts live plus archived references", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-tasks-"));
  await mkdir(path.join(root, "T-001"), { recursive: true });
  await writeFile(path.join(root, "T-001", "task.md"), task("T-001", "done"));
  await mkdir(path.join(root, "archive", "T-002"), { recursive: true });
  await writeFile(
    path.join(root, "archive", "T-002", "task.md"),
    task("T-002", "done"),
  );
  const result = await validate(root);
  assert.equal(result.code, 0);
});
test("task validator rejects inconsistent done tasks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-tasks-invalid-"));
  await mkdir(path.join(root, "T-003"), { recursive: true });
  await writeFile(
    path.join(root, "T-003", "task.md"),
    task("T-003", "done", "[ ]"),
  );
  const result = await validate(root);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /unchecked work/);
});

test("tasks list returns live task summaries and filters by state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-tasks-list-"));
  await mkdir(path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-001"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-001", "task.md"),
    "---\nid: T-001\ntitle: First\nstate: active\ngoal: Test goal\nupdated_at: 2026-09-13\n---\n",
  );
  await mkdir(path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-002"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-002", "task.md"),
    "---\nid: T-002\ntitle: Second\nstate: todo\ngoal: Not yet\n---\n",
  );
  await mkdir(path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-003"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-003", "task.md"),
    "---\nid: T-003\ntitle: \"Quoted — title\"\nstate: active\ngoal: Quotes\n---\n",
  );
  const result = spawnSync(
    process.execPath,
    [path.resolve("dist/main.js"), "tasks", "list", "active"],
    { env: { ...process.env, OCEAN_ROOT: root }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    {
      id: "T-001",
      title: "First",
      state: "active",
      goal: "Test goal",
      updatedAt: "2026-09-13",
    },
    {
      id: "T-003",
      title: "Quoted — title",
      state: "active",
      goal: "Quotes",
      updatedAt: "",
    },
  ]);
});

test("tasks list reads the selected project instead of the default project only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-project-tasks-"));
  await mkdir(path.join(root, PROJECTS_DIR, "frontend", "tasks", "T-101"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, PROJECTS_DIR, "frontend", "tasks", "T-101", "task.md"),
    "---\nid: T-101\ntitle: Frontend\nstate: active\ngoal: Ship UI\n---\n",
  );
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    const { listTasks } = await import(
      "../dist/interfaces/cli/tasks-command.js"
    );
    assert.deepEqual(
      (await listTasks(undefined, "frontend")).map((item) => item.id),
      ["T-101"],
    );
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});
