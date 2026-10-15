import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getTask } from "../dist/application/handoff/handoff-service.js";
import {
  archiveDoneTasks,
  completeTask,
} from "../dist/application/tasks/archive-tasks.js";
import { PROJECTS_DIR } from "../dist/paths.js";

const task = (id, state = "done", checklist = "[x]") =>
  `---\nid: ${id}\nproject: ocean\nstate: ${state}\n---\n\n## Definition of done\n\n- ${checklist} acceptance criterion\n\n## Verification\n\n- \`pnpm test\`\n\n## Blockers\n\nNone.\n`;
const passingCheck = async () => ({ exitCode: 0 });

test("archives verified done tasks and leaves other states live", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-task-archive-"));
  await mkdir(path.join(root, "T-001"), { recursive: true });
  await mkdir(path.join(root, "T-002"), { recursive: true });
  await mkdir(path.join(root, "T-003"), { recursive: true });
  await writeFile(path.join(root, "T-001", "task.md"), task("T-001"));
  await writeFile(
    path.join(root, "T-001", "migration-manifest.md"),
    "manifest",
  );
  await writeFile(path.join(root, "T-002", "task.md"), task("T-002", "active"));
  await writeFile(
    path.join(root, "T-003", "task.md"),
    task("T-003", "done", "[ ]"),
  );

  const preview = await archiveDoneTasks(root);
  assert.deepEqual(preview.candidates, ["T-001"]);
  assert.equal(preview.moved.length, 0);
  await access(path.join(root, "T-001", "task.md"));

  const applied = await archiveDoneTasks(root, true, { run: passingCheck });
  assert.deepEqual(applied.moved, ["T-001"]);
  assert.equal(
    await readFile(
      path.join(root, "archive", "Ocean", "T-001", "task.md"),
      "utf8",
    ),
    task("T-001"),
  );
  assert.equal(
    await readFile(
      path.join(root, "archive", "Ocean", "T-001", "migration-manifest.md"),
      "utf8",
    ),
    "manifest",
  );
  await access(path.join(root, "T-002", "task.md"));
  await access(path.join(root, "T-003", "task.md"));
});

test("archives cancelled tasks alongside done ones", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ocean-task-archive-cancelled-"),
  );
  await mkdir(path.join(root, "T-009"), { recursive: true });
  await writeFile(
    path.join(root, "T-009", "task.md"),
    task("T-009", "cancelled"),
  );

  const preview = await archiveDoneTasks(root);
  assert.deepEqual(preview.candidates, ["T-009"]);

  const applied = await archiveDoneTasks(root, true, { run: passingCheck });
  assert.deepEqual(applied.moved, ["T-009"]);
  assert.equal(
    await readFile(
      path.join(root, "archive", "Ocean", "T-009", "task.md"),
      "utf8",
    ),
    task("T-009", "cancelled"),
  );
});

test("repairs artifacts left by the old task-only archiver", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ocean-task-archive-repair-"),
  );
  await mkdir(path.join(root, "T-004"), { recursive: true });
  await mkdir(path.join(root, "archive", "Ocean", "T-004"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, "archive", "Ocean", "T-004", "task.md"),
    task("T-004"),
  );
  await writeFile(
    path.join(root, "T-004", "migration-manifest.md"),
    "legacy artifact",
  );

  const repaired = await archiveDoneTasks(root, true, { run: passingCheck });
  assert.deepEqual(repaired.repaired, ["T-004"]);
  assert.equal(
    await readFile(
      path.join(root, "archive", "Ocean", "T-004", "migration-manifest.md"),
      "utf8",
    ),
    "legacy artifact",
  );
  await assert.rejects(access(path.join(root, "T-004")));
});

test("completes and archives a task in one governed transition", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-task-complete-"));
  await mkdir(path.join(root, "T-005"), { recursive: true });
  await writeFile(path.join(root, "T-005", "task.md"), task("T-005", "active"));
  await writeFile(path.join(root, "T-005", "notes.md"), "preserve me");

  const result = await completeTask("T-005", root, { run: passingCheck });
  assert.deepEqual(result.moved, ["T-005"]);
  assert.equal(
    await readFile(
      path.join(root, "archive", "Ocean", "T-005", "task.md"),
      "utf8",
    ),
    task("T-005"),
  );
  assert.equal(
    await readFile(
      path.join(root, "archive", "Ocean", "T-005", "notes.md"),
      "utf8",
    ),
    "preserve me",
  );
  await assert.rejects(access(path.join(root, "T-005")));
});

test("completion refuses an unchecked task without changing it", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ocean-task-complete-blocked-"),
  );
  await mkdir(path.join(root, "T-006"), { recursive: true });
  const source = task("T-006", "active", "[ ]");
  await writeFile(path.join(root, "T-006", "task.md"), source);

  await assert.rejects(
    completeTask("T-006", root, { run: passingCheck }),
    /unchecked acceptance criteria/,
  );
  assert.equal(
    await readFile(path.join(root, "T-006", "task.md"), "utf8"),
    source,
  );
});

test("completion refuses unresolved blockers without changing task state", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ocean-task-complete-blockers-"),
  );
  await mkdir(path.join(root, "T-010"), { recursive: true });
  const source = task("T-010", "active").replace(
    "None.",
    "None.\n- historical session paths still need an owner mapping",
  );
  await writeFile(path.join(root, "T-010", "task.md"), source);

  await assert.rejects(
    completeTask("T-010", root, { run: passingCheck }),
    /unresolved blockers/,
  );
  assert.equal(
    await readFile(path.join(root, "T-010", "task.md"), "utf8"),
    source,
  );
  await access(path.join(root, "T-010", "task.md"));
});

test("completion refuses prose criteria that have not been explicitly checked", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ocean-task-complete-criteria-"),
  );
  await mkdir(path.join(root, "T-011"), { recursive: true });
  const source = task("T-011", "active").replace(
    "- [x] acceptance criterion",
    "- Acceptance criteria are described but not checked.",
  );
  await writeFile(path.join(root, "T-011", "task.md"), source);

  await assert.rejects(
    completeTask("T-011", root, { run: passingCheck }),
    /acceptance criteria must use checked boxes/,
  );
  assert.equal(
    await readFile(path.join(root, "T-011", "task.md"), "utf8"),
    source,
  );
  await access(path.join(root, "T-011", "task.md"));
});

test("completion checks every acceptance criterion", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ocean-task-complete-multiple-criteria-"),
  );
  await mkdir(path.join(root, "T-014"), { recursive: true });
  const source = task("T-014", "active").replace(
    "- [x] acceptance criterion",
    "- [x] first criterion\n- [ ] second criterion",
  );
  await writeFile(path.join(root, "T-014", "task.md"), source);

  await assert.rejects(
    completeTask("T-014", root, { run: passingCheck }),
    /unchecked acceptance criteria/,
  );
  assert.equal(
    await readFile(path.join(root, "T-014", "task.md"), "utf8"),
    source,
  );
});

test("archive --apply cannot bypass blockers on a task already marked done", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ocean-task-archive-blocked-"),
  );
  await mkdir(path.join(root, "T-012"), { recursive: true });
  await writeFile(
    path.join(root, "T-012", "task.md"),
    task("T-012").replace("None.", "Open integration issue."),
  );

  const result = await archiveDoneTasks(root, true, { run: passingCheck });
  assert.deepEqual(result.moved, []);
  assert.match(result.skipped[0].reason, /unresolved blockers/);
  await access(path.join(root, "T-012", "task.md"));
});

test("archive dry run reports completion gates without changing the task", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ocean-task-archive-preview-gates-"),
  );
  await mkdir(path.join(root, "T-015"), { recursive: true });
  const source = task("T-015").replace(
    "None.",
    "Unresolved integration issue.",
  );
  await writeFile(path.join(root, "T-015", "task.md"), source);

  const result = await archiveDoneTasks(root);

  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.skipped, [
    { id: "T-015", reason: "unresolved blockers" },
  ]);
  assert.equal(
    await readFile(path.join(root, "T-015", "task.md"), "utf8"),
    source,
  );
});

test("archive --apply reruns verification for done tasks", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ocean-task-archive-verification-"),
  );
  await mkdir(path.join(root, "T-013"), { recursive: true });
  await writeFile(path.join(root, "T-013", "task.md"), task("T-013"));

  const result = await archiveDoneTasks(root, true, {
    run: async () => ({ exitCode: 1 }),
  });
  assert.deepEqual(result.moved, []);
  assert.match(result.skipped[0].reason, /verification failed/);
  await access(path.join(root, "T-013", "task.md"));
});

test("rejects traversal in task reads and archive metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-task-traversal-"));
  const tasksRoot = path.join(root, PROJECTS_DIR, "ocean", "tasks");
  await mkdir(tasksRoot, { recursive: true });
  await writeFile(path.join(root, "outside.md"), task("outside"));
  process.env.OCEAN_ROOT = root;
  try {
    await assert.rejects(getTask("../outside"), /is not a task id/);
  } finally {
    delete process.env.OCEAN_ROOT;
  }

  await mkdir(path.join(tasksRoot, "T-007"), { recursive: true });
  await writeFile(
    path.join(tasksRoot, "T-007", "task.md"),
    task("../../outside"),
  );
  await assert.rejects(
    archiveDoneTasks(tasksRoot, true, { run: passingCheck }),
    /Path escapes its allowed root/,
  );

  await mkdir(path.join(tasksRoot, "T-008"), { recursive: true });
  await writeFile(
    path.join(tasksRoot, "T-008", "task.md"),
    task("T-008").replace("project: ocean", "project: ../../outside"),
  );
  await assert.rejects(
    archiveDoneTasks(tasksRoot, true, { run: passingCheck }),
    /Path escapes its allowed root/,
  );
});

test("a task whose project field says ocean archives under Ocean, other projects keep their own namespace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-archive-project-"));
  for (const [id, project] of [
    ["T-300", "ocean"],
    ["T-301", "ocean-language"],
  ]) {
    await mkdir(path.join(root, id), { recursive: true });
    await writeFile(
      path.join(root, id, "task.md"),
      task(id).replace(/^project:.*$/m, `project: ${project}`),
    );
  }
  const result = await archiveDoneTasks(root, true, { run: passingCheck });
  assert.deepEqual(result.moved.sort(), ["T-300", "T-301"]);
  await access(path.join(root, "archive", "Ocean", "T-300", "task.md"));
  await access(
    path.join(root, "archive", "ocean-language", "T-301", "task.md"),
  );
});

test("getTask finds an archived task under the Ocean namespace only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-gettask-ns-"));
  const tasksRoot = path.join(root, PROJECTS_DIR, "ocean", "tasks");
  for (const [namespace, id] of [
    ["Legacy", "T-400"],
    ["Ocean", "T-401"],
  ]) {
    await mkdir(path.join(tasksRoot, "archive", namespace, id), {
      recursive: true,
    });
    await writeFile(
      path.join(tasksRoot, "archive", namespace, id, "task.md"),
      task(id),
    );
  }
  process.env.OCEAN_ROOT = root;
  try {
    await assert.rejects(getTask("T-400"));
    assert.equal((await getTask("T-401")).id, "T-401");
  } finally {
    delete process.env.OCEAN_ROOT;
  }
});

test("getTask reads live and archived tasks from a migrated ocean/tasks folder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-gettask-migrated-"));
  const tasksRoot = path.join(root, PROJECTS_DIR, "ocean", "tasks");
  await mkdir(path.join(tasksRoot, "T-500"), { recursive: true });
  await writeFile(
    path.join(tasksRoot, "T-500", "task.md"),
    task("T-500", "active"),
  );
  await mkdir(path.join(tasksRoot, "archive", "Ocean", "T-501"), {
    recursive: true,
  });
  await writeFile(
    path.join(tasksRoot, "archive", "Ocean", "T-501", "task.md"),
    task("T-501"),
  );
  process.env.OCEAN_ROOT = root;
  try {
    assert.equal((await getTask("T-500")).id, "T-500");
    assert.equal((await getTask("T-501")).id, "T-501");
  } finally {
    delete process.env.OCEAN_ROOT;
  }
});
