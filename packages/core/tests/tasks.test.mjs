import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PROJECTS_DIR, SYSTEM_DIR } from "../dist/paths.js";

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
    '---\nid: T-003\ntitle: "Quoted — title"\nstate: active\ngoal: Quotes\n---\n',
  );
  const result = spawnSync(
    process.execPath,
    [path.resolve("dist/main.js"), "tasks", "list", "active"],
    { cwd: root, env: { ...process.env, OCEAN_ROOT: root }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    {
      id: "T-001",
      title: "First",
      state: "active",
      goal: "Test goal",
      updatedAt: "2026-09-13",
      project: "ocean",
    },
    {
      id: "T-003",
      title: "Quoted — title",
      state: "active",
      goal: "Quotes",
      updatedAt: "",
      project: "ocean",
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

// Two projects with tasks and a repo bound to one of them; `ocean tasks` runs from `cwd`.
async function twoProjects() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-cwd-tasks-"));
  const write = async (project, id, state) => {
    const dir = path.join(root, PROJECTS_DIR, project, "tasks", id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "task.md"),
      `---\nid: ${id}\ntitle: ${project} ${id}\nstate: ${state}\nproject: ${project}\n---\n\n## Log\n\n## Next action\n\nx\n`,
    );
  };
  await write("ocean", "T-001", "active");
  await write("shop", "T-101", "active");
  await write("shop", "T-102", "todo");
  await mkdir(path.join(root, PROJECTS_DIR, "quiet", "tasks"), {
    recursive: true,
  });
  const shopRepo = await mkdtemp(path.join(os.tmpdir(), "ocean-shop-repo-"));
  const quietRepo = await mkdtemp(path.join(os.tmpdir(), "ocean-quiet-repo-"));
  for (const [project, repo] of [
    ["shop", shopRepo],
    ["quiet", quietRepo],
  ])
    await writeFile(
      path.join(root, PROJECTS_DIR, project, "project.json"),
      JSON.stringify({ name: project, paths: [repo] }),
    );
  const run = (cwd, ...args) =>
    spawnSync(
      process.execPath,
      [path.resolve("dist/main.js"), "tasks", ...args],
      {
        cwd,
        env: { ...process.env, OCEAN_ROOT: root },
        encoding: "utf8",
      },
    );
  return { root, shopRepo, quietRepo, run };
}

const ids = (result) =>
  JSON.parse(result.stdout).map((task) => `${task.project}/${task.id}`);

test("tasks list in a project's repo shows that project's tasks only", async () => {
  const { shopRepo, run } = await twoProjects();
  const result = run(shopRepo, "list");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(ids(result), ["shop/T-101", "shop/T-102"]);
  assert.equal(result.stderr.includes("showing every project"), false);
});

test("tasks list falls back to every project when this one has none, and says so", async () => {
  const { quietRepo, run } = await twoProjects();
  const result = run(quietRepo, "list", "active");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(ids(result), ["ocean/T-001", "shop/T-101"]);
  assert.match(
    result.stderr,
    /No active tasks in quiet; showing every project/,
  );
});

test("tasks list outside any project shows every project's tasks", async () => {
  const { run } = await twoProjects();
  const result = run(
    await mkdtemp(path.join(os.tmpdir(), "ocean-nowhere-")),
    "list",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(ids(result), ["ocean/T-001", "shop/T-101", "shop/T-102"]);
  assert.match(result.stderr, /not an Ocean project/);
});

test("an id-based task action finds the project that holds the id", async () => {
  const { root, run } = await twoProjects();
  const result = run(
    await mkdtemp(path.join(os.tmpdir(), "ocean-elsewhere-")),
    "checkpoint",
    "T-101",
    "--note",
    "found it",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).project, "shop");
  assert.match(
    await readFile(
      path.join(root, PROJECTS_DIR, "shop", "tasks", "T-101", "task.md"),
      "utf8",
    ),
    /found it/,
  );
});

test("an id held by two projects needs --project", async () => {
  const { root, run } = await twoProjects();
  const dir = path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-101");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "task.md"),
    "---\nid: T-101\nstate: active\n---\n",
  );
  const result = run(
    await mkdtemp(path.join(os.tmpdir(), "ocean-ambiguous-")),
    "verify",
    "T-101",
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /T-101 exists in ocean, shop; pass --project/);
});

test("an id no project holds is reported as such", async () => {
  const { shopRepo, run } = await twoProjects();
  const result = run(shopRepo, "verify", "T-999");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /T-999 is not a task in any project/);
});

test("index defaults to the folder's project", async () => {
  const { shopRepo, run } = await twoProjects();
  const index = run(shopRepo, "index");
  assert.equal(index.status, 0, index.stderr);
  assert.match(index.stdout, /\| T-101 \|/);
  assert.equal(index.stdout.includes("| T-001 |"), false);
});

test("a corrupt registry fails the task commands closed instead of guessing", async () => {
  const { root, shopRepo, run } = await twoProjects();
  const registry = path.join(root, SYSTEM_DIR, "registry");
  await mkdir(registry, { recursive: true });
  await writeFile(path.join(registry, "project-bindings.json"), "{bad");
  for (const args of [["list"], ["checkpoint", "T-101", "--note", "x"]]) {
    const result = run(shopRepo, ...args);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.equal(result.stdout, "");
  }
});
