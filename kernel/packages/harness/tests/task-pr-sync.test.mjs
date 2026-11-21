import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  prLinks,
  syncTaskPrs,
  targetState,
} from "@ocean/loop/tasks/sync-task-prs.js";

const PR = "https://github.com/acme/app/pull/";
const task = (id, state, { prs = [], done = "- [x] built" } = {}) =>
  `---\nid: ${id}\ntitle: t\nstate: ${state}\nproject: ocean\nopened: 2026-10-07\nupdated: 2026-10-07\nartifacts: [${prs.map((n) => `"${PR}${n}"`).join(", ")}]\n---\n\n## Objective\n\n## Definition of done\n\n${done}\n\n## Next action\n\n## Verification\n\n## Blockers\n\nNone.\n\n## Log\n\n- 2026-10-07 — opened.\n`;

async function workspace(tasks) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-pr-sync-"));
  for (const [id, source] of Object.entries(tasks)) {
    await mkdir(path.join(root, id), { recursive: true });
    await writeFile(path.join(root, id, "task.md"), source);
  }
  return {
    root,
    read: (id) => readFile(path.join(root, id, "task.md"), "utf8"),
    done: () => rm(root, { recursive: true, force: true }),
  };
}

const fetchFrom = (states) => async (link) => {
  const state = states[link.number];
  if (!state) throw new Error(`no PR ${link.number}`);
  return state;
};
const now = new Date("2026-11-21T10:00:00Z");

test("prLinks finds each GitHub PR URL once, anywhere in the task", () => {
  const links = prLinks(
    `artifacts: ["${PR}24"]\nbody ${PR}24 and https://github.com/o/r.x/pull/3#issuecomment-1`,
  );
  assert.deepEqual(
    links.map((link) => [link.repo, link.number]),
    [
      ["acme/app", 24],
      ["o/r.x", 3],
    ],
  );
});

test("targetState: any open → in-qa, otherwise merged → done, closed alone → none", () => {
  assert.equal(targetState(["OPEN", "MERGED"]), "in-qa");
  assert.equal(targetState(["MERGED", "CLOSED"]), "done");
  assert.equal(targetState(["CLOSED"]), null);
  assert.equal(targetState([]), null);
});

test("an open PR moves an active task to in-qa and logs it; dry run writes nothing", async () => {
  const ws = await workspace({ "T-1": task("T-1", "active", { prs: [1] }) });
  try {
    const options = {
      fetchPr: fetchFrom({ 1: "OPEN" }),
      complete: async () => assert.fail("must not complete"),
      now,
    };
    const dry = await syncTaskPrs(ws.root, options);
    assert.deepEqual(
      dry.changed.map((c) => [c.id, c.from, c.to]),
      [["T-1", "active", "in-qa"]],
    );
    assert.match(await ws.read("T-1"), /state: active/);

    await syncTaskPrs(ws.root, { ...options, apply: true });
    const source = await ws.read("T-1");
    assert.match(source, /state: in-qa\n/);
    assert.match(source, /updated: 2026-11-21/);
    assert.match(
      source,
      /## Log\n\n- 2026-11-21 — active → in-qa \(sync\): PR open\.\n\n- 2026-10-07/,
    );
    // A second sync has nothing to do.
    const again = await syncTaskPrs(ws.root, { ...options, apply: true });
    assert.equal(again.changed.length, 0);
  } finally {
    await ws.done();
  }
});

test("all PRs merged goes through the completion gate", async () => {
  const ws = await workspace({ "T-1": task("T-1", "in-qa", { prs: [1, 2] }) });
  try {
    const completed = [];
    const result = await syncTaskPrs(ws.root, {
      fetchPr: fetchFrom({ 1: "MERGED", 2: "CLOSED" }),
      complete: async (id) => completed.push(id),
      apply: true,
      now,
    });
    assert.deepEqual(completed, ["T-1"]);
    assert.deepEqual(
      result.changed.map((c) => [c.id, c.from, c.to]),
      [["T-1", "in-qa", "done"]],
    );
  } finally {
    await ws.done();
  }
});

test("merged but unticked work: no gate call, stays in-qa, an active task moves to in-qa once", async () => {
  const ws = await workspace({
    "T-1": task("T-1", "active", { prs: [1], done: "- [ ] merge" }),
    "T-2": task("T-2", "in-qa", { prs: [1], done: "- [ ] merge" }),
  });
  try {
    const options = {
      fetchPr: fetchFrom({ 1: "MERGED" }),
      complete: async () => assert.fail("gate must not run"),
      apply: true,
      now,
    };
    const result = await syncTaskPrs(ws.root, options);
    assert.deepEqual(
      result.changed.map((c) => [c.id, c.to]),
      [["T-1", "in-qa"]],
    );
    assert.deepEqual(
      result.skipped.map((s) => s.id),
      ["T-1", "T-2"],
    );
    assert.match(result.skipped[0].reason, /unchecked work/);
    assert.match(await ws.read("T-1"), /state: in-qa\n/);
    const untouched = await ws.read("T-2");
    assert.equal(
      untouched,
      task("T-2", "in-qa", { prs: [1], done: "- [ ] merge" }),
    );
    // Re-running adds no further log lines.
    await syncTaskPrs(ws.root, options);
    const lines = (await ws.read("T-1")).match(/\(sync\)/g) ?? [];
    assert.equal(lines.length, 1);
  } finally {
    await ws.done();
  }
});

test("a refused gate keeps the task in-qa with the reason", async () => {
  const ws = await workspace({ "T-1": task("T-1", "active", { prs: [1] }) });
  try {
    const result = await syncTaskPrs(ws.root, {
      fetchPr: fetchFrom({ 1: "MERGED" }),
      complete: async () => {
        throw new Error("Cannot complete T-1: verification failed");
      },
      apply: true,
      now,
    });
    assert.equal(result.changed[0].to, "in-qa");
    assert.match(result.skipped[0].reason, /verification failed/);
    assert.match(
      await ws.read("T-1"),
      /state: in-qa\n[\s\S]*verification failed/,
    );
  } finally {
    await ws.done();
  }
});

test("blocked, done, no-PR and unreadable-PR tasks are left alone", async () => {
  const ws = await workspace({
    "T-1": task("T-1", "blocked", { prs: [1] }),
    "T-2": task("T-2", "done", { prs: [1] }),
    "T-3": task("T-3", "active"),
    "T-4": task("T-4", "active", { prs: [9] }),
  });
  try {
    const result = await syncTaskPrs(ws.root, {
      fetchPr: fetchFrom({ 1: "OPEN" }),
      complete: async () => assert.fail("must not complete"),
      apply: true,
      now,
    });
    assert.equal(result.changed.length, 0);
    assert.deepEqual(result.skipped, [{ id: "T-4", reason: "no PR 9" }]);
  } finally {
    await ws.done();
  }
});
