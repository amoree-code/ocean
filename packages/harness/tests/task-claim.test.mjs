import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CLAIM_TTL_MS,
  claimTask,
  isStale,
  releaseTask,
} from "@ocean/loop/tasks/claim-task.js";

const task = (id, state = "active") =>
  `---\nid: ${id}\ntitle: t\nstate: ${state}\nproject: ocean\nopened: 2026-10-07\nupdated: 2026-10-07\nartifacts: []\n---\n\n## Objective\n\n## Definition of done\n\n## Next action\n\n## Verification\n\n## Blockers\n\n## Log\n`;

async function workspace(tasks = { "T-1": task("T-1"), "T-2": task("T-2") }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-claim-"));
  const tasksRoot = path.join(root, "04-projects", "ocean", "tasks");
  for (const [id, source] of Object.entries(tasks)) {
    await mkdir(path.join(tasksRoot, id), { recursive: true });
    await writeFile(path.join(tasksRoot, id, "task.md"), source);
  }
  const read = (id) => readFile(path.join(tasksRoot, id, "task.md"), "utf8");
  return {
    root,
    tasksRoot,
    read,
    done: () => rm(root, { recursive: true, force: true }),
  };
}
const at = (iso) => new Date(iso);

test("claim writes the fields, bumps updated and keeps the rest of the file", async () => {
  const ws = await workspace();
  try {
    const now = at("2026-10-16T10:00:00.000Z");
    await claimTask("T-1", ws.tasksRoot, {
      by: "sess-a",
      paths: ["kernel/", "./docs"],
      now,
    });
    const source = await ws.read("T-1");
    assert.match(
      source,
      /claimed_by: sess-a\nclaimed_at: 2026-10-16T10:00:00.000Z\nclaimed_paths: \[kernel, docs\]\n---/,
    );
    assert.match(source, /updated: 2026-10-16/);
    assert.match(source, /title: t\nstate: active/);
    assert.match(source, /## Objective/);
  } finally {
    await ws.done();
  }
});

test("another owner is refused while the claim is live, and named", async () => {
  const ws = await workspace();
  try {
    const now = at("2026-10-16T10:00:00.000Z");
    await claimTask("T-1", ws.tasksRoot, { by: "sess-a", now });
    await assert.rejects(
      claimTask("T-1", ws.tasksRoot, {
        by: "sess-b",
        now: at("2026-10-16T10:30:00.000Z"),
      }),
      /claimed by sess-a/,
    );
    assert.match(await ws.read("T-1"), /claimed_by: sess-a/);
  } finally {
    await ws.done();
  }
});

test("the same owner refreshes; a stale claim is taken over; --force overrides", async () => {
  const ws = await workspace();
  try {
    await claimTask("T-1", ws.tasksRoot, {
      by: "sess-a",
      now: at("2026-10-16T10:00:00.000Z"),
    });
    await claimTask("T-1", ws.tasksRoot, {
      by: "sess-a",
      now: at("2026-10-16T11:00:00.000Z"),
    });
    assert.match(await ws.read("T-1"), /claimed_at: 2026-10-16T11:00:00.000Z/);
    const stale = at("2026-10-16T13:30:00.000Z"); // > 2 h after 11:00
    assert.equal(
      (await claimTask("T-1", ws.tasksRoot, { by: "sess-b", now: stale }))
        .tookOver,
      undefined,
    );
    const forced = await claimTask("T-1", ws.tasksRoot, {
      by: "sess-c",
      force: true,
      now: stale,
    });
    assert.equal(forced.tookOver, "sess-b");
  } finally {
    await ws.done();
  }
});

test("overlapping paths held by another owner on another task are refused", async () => {
  const ws = await workspace();
  try {
    const now = at("2026-10-16T10:00:00.000Z");
    await claimTask("T-1", ws.tasksRoot, {
      by: "sess-a",
      paths: ["packages/harness"],
      now,
    });
    await assert.rejects(
      claimTask("T-2", ws.tasksRoot, {
        by: "sess-b",
        paths: ["packages/harness/src"],
        now,
      }),
      /overlaps packages\/harness claimed by sess-a on T-1/,
    );
    await claimTask("T-2", ws.tasksRoot, {
      by: "sess-b",
      paths: ["packages/harness-extra"],
      now,
    });
  } finally {
    await ws.done();
  }
});

test("release: owner may, other owner may not, anyone may once stale", async () => {
  const ws = await workspace();
  try {
    const now = at("2026-10-16T10:00:00.000Z");
    await claimTask("T-1", ws.tasksRoot, {
      by: "sess-a",
      paths: ["kernel"],
      now,
    });
    await assert.rejects(
      releaseTask("T-1", ws.tasksRoot, { by: "sess-b", now }),
      /only that owner/,
    );
    assert.equal(
      (await releaseTask("T-1", ws.tasksRoot, { by: "sess-a", now })).released,
      true,
    );
    assert.doesNotMatch(await ws.read("T-1"), /claimed_/);
    assert.equal(
      (await releaseTask("T-1", ws.tasksRoot, { by: "sess-a", now })).released,
      false,
    );
    await claimTask("T-1", ws.tasksRoot, { by: "sess-a", now });
    const later = at("2026-10-16T14:00:00.000Z");
    assert.equal(
      (await releaseTask("T-1", ws.tasksRoot, { by: "sess-b", now: later }))
        .released,
      true,
    );
  } finally {
    await ws.done();
  }
});

test("bad owner, bad path and finished tasks are rejected", async () => {
  const ws = await workspace({
    "T-1": task("T-1"),
    "T-3": task("T-3", "done"),
  });
  try {
    await assert.rejects(
      claimTask("T-1", ws.tasksRoot, { by: "bad owner\nstate: done" }),
      /--by must be/,
    );
    await assert.rejects(
      claimTask("T-1", ws.tasksRoot, { by: "a", paths: ["../etc"] }),
      /Invalid claim path/,
    );
    await assert.rejects(
      claimTask("T-1", ws.tasksRoot, { by: "a", paths: ["/abs"] }),
      /Invalid claim path/,
    );
    await assert.rejects(
      claimTask("T-3", ws.tasksRoot, { by: "a" }),
      /is done; it cannot be claimed/,
    );
  } finally {
    await ws.done();
  }
});

test("the TTL equals the one `tasks doctor` uses", async () => {
  const script = await readFile(
    path.resolve("scripts/validate-tasks.mjs"),
    "utf8",
  );
  assert.match(script, /const CLAIM_TTL_MS = 2 \* 60 \* 60 \* 1000;/);
  assert.equal(CLAIM_TTL_MS, 2 * 60 * 60 * 1000);
  assert.equal(
    isStale(
      { by: "a", at: "2026-10-16T10:00:00.000Z", paths: [] },
      at("2026-10-16T12:00:01.000Z"),
    ),
    true,
  );
});

test("CLI: A claims, B is refused with exit 1, A releases, B claims, doctor stays clean", async () => {
  const ws = await workspace();
  try {
    const run = (...args) =>
      spawnSync(
        process.execPath,
        [path.resolve("dist/main.js"), "tasks", ...args, "--project", "ocean"],
        {
          cwd: ws.root,
          env: { ...process.env, OCEAN_ROOT: ws.root },
          encoding: "utf8",
        },
      );
    assert.equal(
      run("claim", "T-1", "--by", "sess-a", "--paths", "kernel").status,
      0,
    );
    const refused = run("claim", "T-1", "--by", "sess-b");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /claimed by sess-a/);
    assert.equal(run("release", "T-1", "--by", "sess-a").status, 0);
    assert.equal(run("claim", "T-1", "--by", "sess-b").status, 0);
    const doctor = spawnSync(
      process.execPath,
      [path.resolve("scripts/validate-tasks.mjs"), ws.tasksRoot],
      { encoding: "utf8" },
    );
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.equal(run("claim", "T-1").status, 1);
    assert.match(run("claim", "T-1").stderr, /Usage/);
  } finally {
    await ws.done();
  }
});
