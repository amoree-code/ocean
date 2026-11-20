import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { scoreSession } from "@ocean/brain/memory/lesson-learning.js";
import { parseFrontmatter } from "@ocean/core/shared/fs-utils.js";
import { SessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";
import { completeTask } from "@ocean/loop/tasks/archive-tasks.js";
import { claimTask, releaseTask } from "@ocean/loop/tasks/claim-task.js";
import {
  acceptanceIds,
  parseReviewVerdict,
  setFrontmatterFields,
  verifyAndRecord,
} from "@ocean/loop/tasks/task-verification.js";
import { declaredCommands } from "@ocean/loop/tasks/verify-task.js";

const execFile = promisify(execFileCallback);
const dirs = [];
const stores = [];
test.after(async () => {
  for (const store of stores)
    try {
      store.close();
    } catch {
      // closed by the code under test
    }
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function workspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-t320-"));
  dirs.push(dir);
  const root = path.join(dir, "tasks");
  await mkdir(root, { recursive: true });
  return { dir, root, dbFile: path.join(dir, "sessions.sqlite") };
}

function task({
  id = "T-1",
  extra = "",
  dod = "- [x] The fixture works.",
  verify = "verify: pnpm test",
} = {}) {
  return `---
id: ${id}
title: "fixture"
state: active
project: ocean
opened: 2026-11-20
updated: 2026-11-20
artifacts: []
${verify}
${extra}
---

## Objective

Fixture.

## Definition of done

${dod}

## Next action

None.

## Verification

Fixture.

## Blockers

None.

## Log

- 2026-11-20 — fixture
`.replace("\n\n---\n\n## Objective", "\n---\n\n## Objective");
}

async function writeTask(root, id, body) {
  await mkdir(path.join(root, id), { recursive: true });
  await writeFile(path.join(root, id, "task.md"), body, "utf8");
  return path.join(root, id, "task.md");
}

const runner =
  (exitCodes = {}) =>
  async (command) => ({ exitCode: exitCodes[command] ?? 0 });

function storeFor(dbFile) {
  return async () => {
    const store = new SessionStore(dbFile);
    stores.push(store);
    return store;
  };
}

function linkedSession(dbFile, sessionId, taskId) {
  const store = new SessionStore(dbFile);
  store.create({
    sessionId,
    taskId,
    provider: "claude",
    providerSessionId: null,
    parentSessionId: null,
    profile: "default",
    profileIdentity: "",
    workingDirectory: os.tmpdir(),
    resumeData: null,
  });
  store.updateStatus(sessionId, "running");
  store.updateStatus(sessionId, "completed");
  store.close();
}

test("a passing verify ends verified: yes with evidence ids, a task_verify event, and proven sessions", async () => {
  const { root, dbFile } = await workspace();
  const file = await writeTask(root, "T-1", task());
  linkedSession(dbFile, "work-1", "T-1");
  const outcome = await verifyAndRecord("T-1", root, {
    cwd: os.tmpdir(),
    run: runner(),
    openStore: storeFor(dbFile),
  });
  assert.equal(outcome.verified, "yes");
  assert.equal(outcome.passed, true);
  assert.deepEqual(outcome.sessions, ["work-1"]);
  const fields = parseFrontmatter(await readFile(file, "utf8"));
  assert.equal(fields.verified, "yes");
  assert.match(fields.verified_at, /^\d{4}-\d\d-\d\dT/);
  assert.match(fields.evidence, /^\[check-1:event:\d+\]$/);

  const store = new SessionStore(dbFile);
  stores.push(store);
  const work = store.get("work-1");
  assert.equal(work.verificationStatus, "proven");
  const events = store
    .listEvents("work-1")
    .filter((e) => e.type === "evidence");
  assert.equal(events.length, 1);
  const data = JSON.parse(events[0].data);
  assert.equal(data.type, "task_verify");
  assert.equal(data.result, "proven");
  assert.equal(data.taskId, "T-1");
  // The verify run is its own session, linked to the task, holding the event the task cites.
  const own = store
    .listTaskSessions("T-1")
    .find((s) => s.profile === "tasks-verify");
  assert.equal(own.verificationStatus, "proven");
  const eventId = Number(fields.evidence.match(/event:(\d+)/)[1]);
  assert.ok(store.listEvents(own.sessionId).some((e) => e.eventId === eventId));
  // A work session that carries the verdict now scores as verified for lesson learning.
  assert.equal(scoreSession(work, store.listEvents("work-1")).verified, true);
});

test("a failing verify ends verified: no and the linked session not_proven", async () => {
  const { root, dbFile } = await workspace();
  const file = await writeTask(root, "T-1", task());
  linkedSession(dbFile, "work-1", "T-1");
  const outcome = await verifyAndRecord("T-1", root, {
    cwd: os.tmpdir(),
    run: runner({ "pnpm test": 1 }),
    openStore: storeFor(dbFile),
  });
  assert.equal(outcome.verified, "no");
  assert.equal(outcome.passed, false);
  assert.equal(parseFrontmatter(await readFile(file, "utf8")).verified, "no");
  const store = new SessionStore(dbFile);
  stores.push(store);
  assert.equal(store.get("work-1").verificationStatus, "not_proven");
});

test("no declared commands ends verified: no with a not_proven record", async () => {
  const { root, dbFile } = await workspace();
  const file = await writeTask(root, "T-1", task({ verify: "" }));
  const outcome = await verifyAndRecord("T-1", root, {
    cwd: os.tmpdir(),
    run: runner(),
    openStore: storeFor(dbFile),
  });
  assert.equal(outcome.verified, "no");
  assert.match(
    parseFrontmatter(await readFile(file, "utf8")).evidence,
    /verification:event:/,
  );
});

test("C3: every AC-n needs its own check; a criterion without one makes the task partial", async () => {
  const { root } = await workspace();
  const body = task({
    verify:
      "verify:\n  - AC-1: pnpm build && pnpm test\n  - AC-2: ocean tasks doctor",
    dod: "- [x] AC-1: builds and tests pass.\n- [x] AC-2: doctor is clean.\n- [x] AC-3: docs updated.",
  });
  assert.deepEqual(declaredCommands(body), [
    { ac: "AC-1", command: "pnpm build && pnpm test" },
    { ac: "AC-2", command: "ocean tasks doctor" },
  ]);
  assert.deepEqual(acceptanceIds(body), ["AC-1", "AC-2", "AC-3"]);
  const file = await writeTask(root, "T-1", body);
  const outcome = await verifyAndRecord("T-1", root, {
    cwd: os.tmpdir(),
    run: runner(),
  });
  assert.equal(outcome.verified, "partial");
  assert.equal(outcome.passed, true);
  assert.deepEqual(outcome.acceptance, [
    { id: "AC-1", ok: true },
    { id: "AC-2", ok: true },
    { id: "AC-3", ok: null },
  ]);
  assert.match(outcome.reason, /no check for AC-3/);
  // The block list survives the frontmatter rewrite.
  assert.deepEqual(
    declaredCommands(await readFile(file, "utf8")).map((c) => c.ac),
    ["AC-1", "AC-2"],
  );
});

test("an inline verify with AC labels and a failing AC-2 ends no", async () => {
  const { root } = await workspace();
  await writeTask(
    root,
    "T-1",
    task({
      verify: "verify: AC-1: pnpm test, AC-2: pnpm lint",
      dod: "- [x] AC-1 tests.\n- [x] AC-2 lint.",
    }),
  );
  const outcome = await verifyAndRecord("T-1", root, {
    cwd: os.tmpdir(),
    run: runner({ "pnpm lint": 2 }),
  });
  assert.equal(outcome.verified, "no");
  assert.deepEqual(outcome.acceptance, [
    { id: "AC-1", ok: true },
    { id: "AC-2", ok: false },
  ]);
});

test("a verify: line in the body is prose, never a command", () => {
  const body = task({ verify: "" }).replace(
    "Fixture.\n\n## Blockers",
    "verify: pnpm publish\n\n## Blockers",
  );
  assert.deepEqual(declaredCommands(body), []);
});

test("F1: claim records the base commit once; verify fails when claimed paths never changed", async () => {
  const { root } = await workspace();
  const file = await writeTask(root, "T-1", task());
  let heads = 0;
  const head = async () => `${"a".repeat(39)}${++heads}`;
  await claimTask("T-1", root, { by: "s1", paths: ["kernel"], head });
  const first = parseFrontmatter(await readFile(file, "utf8")).base_commit;
  assert.equal(first, `${"a".repeat(39)}1`);
  await releaseTask("T-1", root, { by: "s1" });
  await claimTask("T-1", root, { by: "s2", paths: ["kernel"], head });
  assert.equal(
    parseFrontmatter(await readFile(file, "utf8")).base_commit,
    first,
  );

  const unchanged = await verifyAndRecord("T-1", root, {
    cwd: os.tmpdir(),
    run: runner(),
    changed: async () => false,
  });
  assert.equal(unchanged.verified, "no");
  assert.match(unchanged.reason, /no change in kernel since base commit/);

  const changed = await verifyAndRecord("T-1", root, {
    cwd: os.tmpdir(),
    run: runner(),
    changed: async (base, paths) => {
      assert.equal(base, first);
      assert.deepEqual(paths, ["kernel"]);
      return true;
    },
  });
  assert.equal(changed.verified, "yes");
});

test("F1 against a real repository: no change fails, a new file passes", async () => {
  const { dir, root } = await workspace();
  const repo = path.join(dir, "repo");
  await mkdir(path.join(repo, "src"), { recursive: true });
  const git = (...args) => execFile("git", args, { cwd: repo });
  await git("init", "-q");
  await git("config", "user.email", "test");
  await git("config", "user.name", "test");
  await writeFile(path.join(repo, "src", "a.txt"), "a");
  await git("add", ".");
  await git("commit", "-qm", "base");
  const { changedSince, headCommit } = await import(
    "@ocean/loop/tasks/task-git.js"
  );
  const base = await headCommit(repo);
  assert.match(base, /^[0-9a-f]{40}$/);
  assert.equal(await changedSince(repo, base, ["src"]), false);
  await writeFile(path.join(repo, "src", "b.txt"), "b");
  assert.equal(await changedSince(repo, base, ["src"]), true);
  assert.equal(await changedSince(repo, "0".repeat(40), ["src"]), null);
  assert.equal(await headCommit(root), null);
});

test("lane: class high without review: agent stays yes and records the review as assumed", async () => {
  const { root } = await workspace();
  const file = await writeTask(root, "T-1", task({ extra: "class: high" }));
  let calls = 0;
  const outcome = await verifyAndRecord("T-1", root, {
    cwd: os.tmpdir(),
    run: runner(),
    reviewer: () => {
      calls += 1;
      return async () => "pass";
    },
  });
  assert.equal(calls, 0, "no model call without the owner's opt-in");
  assert.equal(outcome.lane, "verify+review");
  assert.equal(outcome.verified, "yes");
  assert.match(
    parseFrontmatter(await readFile(file, "utf8")).assumed,
    /independent review not run \(class high; set review: agent to run it\)/,
  );
});

test("F2: review: agent runs after the checks; its last line decides pass or fail", async () => {
  const { root, dbFile } = await workspace();
  await writeTask(root, "T-1", task({ extra: "review: agent" }));
  const prompts = [];
  const pass = await verifyAndRecord("T-1", root, {
    cwd: os.tmpdir(),
    run: runner(),
    openStore: storeFor(dbFile),
    reviewer: () => async (prompt) => {
      prompts.push(prompt);
      return "Every item cites a check.\n\npass";
    },
  });
  assert.equal(pass.verified, "yes");
  assert.equal(pass.review.ran, true);
  assert.match(prompts[0], /End your answer with exactly one line/);
  assert.match(prompts[0], /"passed": true/);
  assert.ok(pass.evidence.some((entry) => entry.startsWith("review:event:")));

  const fail = await verifyAndRecord("T-1", root, {
    cwd: os.tmpdir(),
    run: runner(),
    reviewer: () => async () => "fail — AC-1 cites nothing",
  });
  assert.equal(fail.verified, "no");
  assert.equal(fail.passed, false);
  assert.match(fail.reason, /review: fail — AC-1 cites nothing/);

  const missing = await verifyAndRecord("T-1", root, {
    cwd: os.tmpdir(),
    run: runner(),
    reviewer: () => null,
  });
  assert.equal(missing.verified, "partial");
  assert.equal(missing.review.skipped, "no reviewer is available");

  let called = false;
  const failedChecks = await verifyAndRecord("T-1", root, {
    cwd: os.tmpdir(),
    run: runner({ "pnpm test": 1 }),
    reviewer: () => {
      called = true;
      return async () => "pass";
    },
  });
  assert.equal(failedChecks.verified, "no");
  assert.equal(
    called,
    false,
    "deterministic checks run first; a failure skips the review",
  );
});

test("parseReviewVerdict reads only a final pass or fail line", () => {
  assert.deepEqual(parseReviewVerdict("ok\n`pass`"), {
    passed: true,
    line: "pass",
  });
  assert.equal(parseReviewVerdict("fail — no evidence").passed, false);
  assert.equal(parseReviewVerdict("looks fine to me"), null);
  assert.equal(parseReviewVerdict(null), null);
});

test("setFrontmatterFields replaces a block list and keeps every other line", () => {
  const out = setFrontmatterFields(
    "---\nid: T-1\nevidence:\n  - a\n  - b\nstate: active\n---\nbody\n",
    { evidence: "[x]", verified: "yes" },
  );
  assert.equal(
    out,
    "---\nid: T-1\nevidence: [x]\nstate: active\nverified: yes\n---\nbody\n",
  );
});

test("scoreSession: a provider_exit-only session is not verified; task_verify is, and the latest verdict wins", () => {
  const done = { status: "completed" };
  const event = (type, data, eventId = 1) => ({
    eventId,
    sessionId: "s",
    type,
    data: JSON.stringify(data),
    createdAt: "",
  });
  const exit = event("process_exit", { exitCode: 0 });
  const providerExit = event("evidence", {
    type: "provider_exit",
    result: "proven",
    criterion: "provider process exits successfully",
  });
  const exitOnly = scoreSession(done, [exit, providerExit]);
  assert.equal(exitOnly.verified, false);
  assert.equal(exitOnly.provenCount, 0);

  const verify = (result) =>
    event("evidence", {
      type: "task_verify",
      taskId: "T-1",
      criterion: "AC-1",
      result,
    });
  assert.equal(
    scoreSession(done, [exit, providerExit, verify("proven")]).verified,
    true,
  );
  assert.equal(
    scoreSession(done, [exit, verify("proven"), verify("not_proven")]).verified,
    false,
  );
  assert.equal(
    scoreSession(done, [exit, verify("not_proven"), verify("proven")]).verified,
    true,
  );
  assert.equal(
    scoreSession(done, [
      exit,
      event("evidence", { type: "test", result: "proven" }),
    ]).verified,
    true,
  );
});

test("completeTask with the recording verifier keeps the verdict in the archived task", async () => {
  const { root } = await workspace();
  await writeTask(root, "T-1", task());
  const result = await completeTask("T-1", root, {
    verify: (id, tasksRoot) =>
      verifyAndRecord(id, tasksRoot, { cwd: os.tmpdir(), run: runner() }),
    run: runner(),
  });
  assert.equal(result.state, "done");
  const archived = await readFile(
    path.join(root, "archive", "_workspace", "T-1", "task.md"),
    "utf8",
  ).catch(async () => {
    const { readdir } = await import("node:fs/promises");
    const found = await readdir(path.join(root, "archive"), {
      recursive: true,
    });
    const hit = found.find((entry) =>
      entry.endsWith(path.join("T-1", "task.md")),
    );
    return readFile(path.join(root, "archive", hit), "utf8");
  });
  const fields = parseFrontmatter(archived);
  assert.equal(fields.state, "done");
  assert.equal(fields.verified, "yes");
});

test("tasks doctor fails a done task without verify evidence once the rule applies", async () => {
  const { root } = await workspace();
  const doctor = () =>
    execFile(process.execPath, [
      path.resolve("scripts/validate-tasks.mjs"),
      root,
    ]);
  const done = (extra, updated = "2026-11-25") =>
    task({ extra })
      .replace("state: active", "state: done")
      .replace("updated: 2026-11-20", `updated: ${updated}`);
  await writeTask(root, "T-1", done(""));
  await assert.rejects(doctor(), /done without verify evidence/);
  await writeTask(
    root,
    "T-1",
    done("verified: no\nevidence: [check-1:event:4]"),
  );
  await assert.rejects(doctor(), /done but verified: no/);
  await writeTask(root, "T-1", done("verified: yes\nevidence: []"));
  await assert.rejects(doctor(), /done with no evidence ids/);
  await writeTask(root, "T-1", done("verified: maybe\nevidence: [x]"));
  await assert.rejects(doctor(), /verified must be one of/);
  await writeTask(
    root,
    "T-1",
    done("verified: yes\nevidence: [check-1:event:4]"),
  );
  await doctor();
  // A task last touched before the rule shipped only warns: no back-fill.
  await writeTask(root, "T-1", done("", "2026-11-19"));
  const { stderr } = await doctor();
  assert.match(stderr, /predates T-320; not enforced/);
});
