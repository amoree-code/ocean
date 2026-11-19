import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeSessionEndHook } from "@ocean/loop/hooks/session-end-hook.js";
import { openSessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";
import {
  branchTaskTokens,
  gitBranchAt,
  resolveSessionTask,
  taskForSession,
} from "@ocean/loop/tasks/session-task.js";
import { defaultSessionStoreFactory } from "../dist/composition/runtime.js";

// T-319: a session that names no task gets one from its branch or a live claim — never a guess.

const write = async (root, file, text) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
};

const task = (id, extra = {}) => ({
  id,
  project: "ocean",
  state: "active",
  claim: null,
  ...extra,
});

const NOW = new Date("2026-11-19T12:00:00.000Z");
const fresh = "2026-11-19T11:00:00.000Z";
const expired = "2026-11-19T09:00:00.000Z";

test("branch tokens: t318, t-318 and prefixed ids; words without a number are not ids", () => {
  assert.deepEqual(branchTaskTokens("feat/t318-scorecard"), ["T-318"]);
  assert.deepEqual(branchTaskTokens("fix/T-318-writers"), ["T-318"]);
  assert.deepEqual(branchTaskTokens("cws-003_login"), ["CWS-3"]);
  assert.deepEqual(branchTaskTokens("ci/faster-gate"), []);
  assert.deepEqual(branchTaskTokens("main"), []);
});

test("the branch names the task; T-3 and T-003 are one task; cancelled never matches", () => {
  const base = { cwd: "/w/x", projectId: "ocean", root: "/w", now: NOW };
  assert.equal(
    taskForSession({
      ...base,
      branch: "feat/t318-scorecard",
      candidates: [task("T-317"), task("T-318")],
    }),
    "T-318",
  );
  assert.equal(
    taskForSession({
      ...base,
      branch: "feat/t3-x",
      candidates: [task("T-003")],
    }),
    "T-003",
  );
  assert.equal(
    taskForSession({
      ...base,
      branch: "feat/t318-x",
      candidates: [task("T-318", { state: "cancelled" })],
    }),
    null,
  );
});

test("the same id in two projects: the session's project wins, otherwise no answer", () => {
  const candidates = [
    task("T-5", { project: "ocean" }),
    task("T-5", { project: "resume" }),
  ];
  const base = {
    cwd: "/w",
    branch: "feat/t5",
    root: "/w",
    now: NOW,
    candidates,
  };
  assert.equal(taskForSession({ ...base, projectId: "resume" }), "T-5");
  assert.equal(taskForSession({ ...base, projectId: null }), null);
});

test("a live claim on a path holding the directory; expired or ambiguous claims do not count", () => {
  const base = { branch: "main", projectId: null, root: "/w", now: NOW };
  const kernel = (id, at) => task(id, { claim: { at, paths: ["kernel"] } });
  assert.equal(
    taskForSession({
      ...base,
      cwd: "/w/kernel/packages",
      candidates: [kernel("T-319", fresh)],
    }),
    "T-319",
  );
  // Outside the claimed path.
  assert.equal(
    taskForSession({
      ...base,
      cwd: "/w/kernelish",
      candidates: [kernel("T-319", fresh)],
    }),
    null,
  );
  assert.equal(
    taskForSession({
      ...base,
      cwd: "/w/kernel",
      candidates: [kernel("T-319", expired)],
    }),
    null,
  );
  assert.equal(
    taskForSession({
      ...base,
      cwd: "/w/kernel",
      candidates: [kernel("T-319", fresh), kernel("T-320", fresh)],
    }),
    null,
  );
  // The branch outranks a claim.
  assert.equal(
    taskForSession({
      ...base,
      branch: "feat/t320-x",
      cwd: "/w/kernel",
      candidates: [kernel("T-319", fresh), task("T-320")],
    }),
    "T-320",
  );
});

test("a task's own folder wins; a branch says nothing inside a workspace area with no code", () => {
  const candidates = [
    task("T-296", { dir: "/w/04-projects/ocean/tasks/T-296" }),
    task("T-319"),
  ];
  const base = {
    branch: "feat/t319-session-task",
    projectId: "ocean",
    root: "/w",
    now: NOW,
    candidates,
    noCodeDirs: ["/w/02-personal", "/w/bridge"],
  };
  assert.equal(
    taskForSession({ ...base, cwd: "/w/04-projects/ocean/tasks/T-296/notes" }),
    "T-296",
  );
  assert.equal(taskForSession({ ...base, cwd: "/w" }), "T-319");
  assert.equal(taskForSession({ ...base, cwd: "/w/kernel" }), "T-319");
  assert.equal(taskForSession({ ...base, cwd: "/w/02-personal/notes" }), null);
  // A live claim still counts there: the owner claimed that path for the task.
  assert.equal(
    taskForSession({
      ...base,
      cwd: "/w/02-personal",
      candidates: [
        task("T-319", { claim: { at: fresh, paths: ["02-personal"] } }),
      ],
    }),
    "T-319",
  );
});

test("gitBranchAt reads HEAD from a repo and from a worktree's .git file; detached is null", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-branch-"));
  await write(
    dir,
    "repo/.git/HEAD",
    "ref: refs/heads/feat/t319-session-task\n",
  );
  await mkdir(path.join(dir, "repo/sub/deeper"), { recursive: true });
  assert.equal(
    await gitBranchAt(path.join(dir, "repo/sub/deeper")),
    "feat/t319-session-task",
  );
  await write(dir, "gitdirs/wt/HEAD", "ref: refs/heads/fix/t318-writers\n");
  await write(dir, "wt/.git", `gitdir: ${path.join(dir, "gitdirs/wt")}\n`);
  assert.equal(await gitBranchAt(path.join(dir, "wt")), "fix/t318-writers");
  await write(dir, "detached/.git/HEAD", "4c2c752aa\n");
  assert.equal(await gitBranchAt(path.join(dir, "detached")), null);
});

test("a hook-recorded session carries the task its branch names, end to end", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-session-task-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await write(
      root,
      "04-projects/personal/ocean/tasks/T-319/task.md",
      "---\nid: T-319\nstate: active\n---\n",
    );
    await write(
      root,
      "repo/.git/HEAD",
      "ref: refs/heads/feat/t319-session-task\n",
    );
    const cwd = path.join(root, "repo");
    assert.equal(await resolveSessionTask(cwd, null), "T-319");
    await claudeSessionEndHook(
      {
        session_id: "hook-task-session-1",
        cwd,
        hook_event_name: "SessionEnd",
        reason: "other",
      },
      defaultSessionStoreFactory,
    );
    const store = await openSessionStore();
    try {
      assert.equal(store.get("hook-task-session-1")?.taskId, "T-319");
    } finally {
      store.close();
    }
    // Off any task branch, with no claim: no task.
    await write(root, "other/.git/HEAD", "ref: refs/heads/main\n");
    assert.equal(
      await resolveSessionTask(path.join(root, "other"), null),
      null,
    );
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});
