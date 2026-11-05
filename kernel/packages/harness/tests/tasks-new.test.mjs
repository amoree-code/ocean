import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const record = (id) =>
  `---\nid: ${id}\ntitle: t\nstate: active\nproject: lab\nopened: 2026-10-07\nupdated: 2026-10-07\nartifacts: []\n---\n\n## Objective\n\n## Definition of done\n\n## Next action\n\n## Verification\n\n## Blockers\n\n## Log\n`;

// A project whose manifest counter lags behind the records on disk, as crm-web-sdk's did.
async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-tasks-new-"));
  const folder = path.join(root, "04-projects", "lab");
  await mkdir(path.join(folder, "tasks", "LB-4"), { recursive: true });
  await writeFile(
    path.join(folder, "tasks", "LB-4", "task.md"),
    record("LB-4"),
  );
  await mkdir(path.join(folder, "tasks", "archive", "2026", "LB-7"), {
    recursive: true,
  });
  await writeFile(
    path.join(folder, "tasks", "archive", "2026", "LB-7", "task.md"),
    record("LB-7"),
  );
  await writeFile(
    path.join(folder, "project.json"),
    JSON.stringify({
      id: "lab",
      name: "lab",
      paths: [root],
      prefix: "LB",
      nextTask: 2,
    }),
  );
  return { root, folder };
}

const run = (root, ...args) =>
  spawnSync(
    process.execPath,
    [path.resolve("dist/main.js"), "tasks", ...args],
    {
      cwd: root,
      env: { ...process.env, OCEAN_ROOT: root },
      encoding: "utf8",
    },
  );

test("tasks new takes the next id after every record on disk and advances the counter", async () => {
  const { root, folder } = await workspace();
  try {
    const first = run(
      root,
      "new",
      "Fix the login: redirect",
      "--project",
      "lab",
    );
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).id, "LB-008");
    const second = JSON.parse(
      run(root, "new", "Second", "--project", "lab").stdout,
    );
    assert.equal(second.id, "LB-009");
    const manifest = JSON.parse(
      await readFile(path.join(folder, "project.json"), "utf8"),
    );
    assert.equal(manifest.nextTask, 10);
    const created = await readFile(
      path.join(folder, "tasks", "LB-008", "task.md"),
      "utf8",
    );
    assert.match(created, /^title: "Fix the login: redirect"$/m);
    assert.match(created, /## Definition of done\n\n- \[ \] /);
    const doctor = spawnSync(
      process.execPath,
      [path.resolve("scripts/validate-tasks.mjs"), path.join(folder, "tasks")],
      { encoding: "utf8" },
    );
    assert.equal(doctor.status, 0, doctor.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tasks new refuses a missing or multi-line title and consumes no id", async () => {
  const { root, folder } = await workspace();
  try {
    assert.equal(run(root, "new", "--project", "lab").status, 1);
    assert.equal(run(root, "new", "a\nb", "--project", "lab").status, 1);
    const manifest = JSON.parse(
      await readFile(path.join(folder, "project.json"), "utf8"),
    );
    assert.equal(manifest.nextTask, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tasks new refuses a project that does not exist and creates nothing", async () => {
  const { root } = await workspace();
  try {
    const result = run(root, "new", "Probe", "--project", "no-such-project");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No project no-such-project/);
    await assert.rejects(
      readFile(
        path.join(
          root,
          "04-projects",
          "no-such-project",
          "tasks",
          "T-001",
          "task.md",
        ),
      ),
    );
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual((await readdir(path.join(root, "04-projects"))).sort(), [
      "lab",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
