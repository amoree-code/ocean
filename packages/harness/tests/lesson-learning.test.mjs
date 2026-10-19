import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  learnFromSession,
  PROMOTION_HITS,
  promoteLesson,
  replayEval,
  scoreSession,
} from "@ocean/brain/memory/lesson-learning.js";
import {
  addLesson,
  confirmLesson,
  lessonsDir,
  listLessons,
  readLesson,
} from "@ocean/brain/memory/lessons.js";
import { SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { SessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";
import { finalizeSession } from "@ocean/loop/sessions/session-closeout.js";
import { detectSessionSignals } from "@ocean/market/skills/signal-detection.js";

const previousRoot = process.env.OCEAN_ROOT;
const roots = [];
test.after(async () => {
  if (previousRoot === undefined) delete process.env.OCEAN_ROOT;
  else process.env.OCEAN_ROOT = previousRoot;
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});

async function freshStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-learning-"));
  roots.push(root);
  process.env.OCEAN_ROOT = root;
  await mkdir(path.join(root, SYSTEM_DIR, "sessions"), { recursive: true });
  return {
    root,
    store: new SessionStore(
      path.join(root, SYSTEM_DIR, "sessions", "sessions.sqlite"),
    ),
  };
}

const PROCEDURE = "Run the build with pnpm build before committing the change";

function session(
  store,
  id,
  events,
  { status = "completed", exitCode = 0 } = {},
) {
  store.create({
    sessionId: id,
    title: id,
    taskId: null,
    handoffId: null,
    provider: "claude",
    providerSessionId: null,
    parentSessionId: null,
    profile: "reviewer",
    profileIdentity: "h",
    workingDirectory: os.tmpdir(),
    resumeData: null,
  });
  store.updateStatus(id, "running");
  for (const [type, data] of events)
    store.appendEvent(
      id,
      type,
      typeof data === "string" ? data : JSON.stringify(data),
    );
  store.appendEvent(id, "process_exit", JSON.stringify({ exitCode }));
  store.updateStatus(id, status);
}

const proven = ["evidence", { result: "proven", criterion: "build passes" }];
const repeated = [
  ["provider_output", PROCEDURE],
  ["provider_output", PROCEDURE],
];

test("a session is verified only when it completed, exited 0, and every evidence event is proven", async () => {
  const { store } = await freshStore();
  session(store, "ok", [proven]);
  session(store, "no-evidence", []);
  session(store, "unproven", [proven, ["evidence", { result: "notProven" }]]);
  session(store, "bad-exit", [proven], { exitCode: 2 });
  session(store, "failed", [proven], { status: "failed" });
  const verdict = (id) =>
    scoreSession(store.get(id), store.listEvents(id)).verified;
  assert.deepEqual(
    ["ok", "no-evidence", "unproven", "bad-exit", "failed"].map(verdict),
    [true, false, false, false, false],
  );
});

test("promotion needs three verified hits and a passing eval", async () => {
  await freshStore();
  const pass = async () => ({ passed: true, reason: "ok" });
  const fail = async () => ({ passed: false, reason: "replay failed" });
  await addLesson({ id: "gate", title: "t", body: "b" });
  const hit = async (n) => {
    for (let i = 0; i < n; i++)
      await confirmLesson("gate", { evidence: `session:s${i}` });
  };
  await hit(PROMOTION_HITS - 1);
  assert.match((await promoteLesson("gate", pass)).reason, /2 of 3/);
  await hit(1);
  assert.deepEqual(await promoteLesson("gate", fail), {
    promoted: false,
    reason: "replay failed",
  });
  assert.equal((await readLesson("gate")).status, "candidate");
  assert.equal((await promoteLesson("gate", pass)).promoted, true);
  assert.equal((await readLesson("gate")).status, "active");
  assert.equal((await promoteLesson("gate", pass)).reason, "already active");
});

test("replayEval ignores hits whose session no longer verifies", async () => {
  const { store } = await freshStore();
  session(store, "a", [proven]);
  session(store, "b", [proven]);
  session(store, "c", [proven, ["evidence", { result: "notProven" }]]);
  const lesson = {
    evidence: ["session:a", "session:b", "session:c", "session:gone"],
  };
  const result = await replayEval(store)(lesson);
  assert.equal(result.passed, false);
  assert.match(result.reason, /2 of 3/);
});

test("the same procedure verified in four sessions becomes an active lesson", async () => {
  const { store } = await freshStore();
  const stages = [];
  for (const id of ["s1", "s2", "s3", "s4"]) {
    session(store, id, [...repeated, proven]);
    const learning = await learnFromSession(store, id);
    const [lesson] = await listLessons();
    stages.push([
      lesson.status,
      lesson.hits,
      learning.created.length,
      learning.promoted.length,
    ]);
  }
  assert.deepEqual(stages, [
    ["candidate", 0, 1, 0],
    ["candidate", 1, 0, 0],
    ["candidate", 2, 0, 0],
    ["active", 3, 0, 1],
  ]);
});

test("an unverified session teaches nothing", async () => {
  const { store } = await freshStore();
  session(store, "u", [
    ...repeated,
    proven,
    ["evidence", { result: "notProven" }],
  ]);
  const learning = await learnFromSession(store, "u");
  assert.equal(learning.score.verified, false);
  assert.deepEqual(await listLessons(), []);
});

test("a user correction in a session that used a lesson contradicts it", async () => {
  const { store } = await freshStore();
  await addLesson({ id: "used", title: "t", body: "b", confidence: 0.8 });
  session(store, "c1", [
    ["skill_auto_activated", { id: "used" }],
    ["user_input", "No, that's wrong — use npm here instead"],
    proven,
  ]);
  const learning = await learnFromSession(store, "c1");
  assert.deepEqual(learning.contradicted, ["used"]);
  assert.ok((await readLesson("used")).confidence < 0.5);
  assert.match(
    await readFile(path.join(lessonsDir(), "CONFLICTS.md"), "utf8"),
    /`used` contradicted/,
  );
});

test("finalizeSession scores the session and records the outcome as an event", async () => {
  const { store } = await freshStore();
  session(store, "f1", [...repeated, proven]);
  await finalizeSession(store, "f1");
  const [lesson] = await listLessons();
  assert.equal(lesson.status, "candidate");
  const scored = store.listEvents("f1").find((e) => e.type === "lesson_scored");
  assert.deepEqual(JSON.parse(scored.data).created, [lesson.id]);
  await finalizeSession(store, "f1");
  assert.equal((await listLessons()).length, 1);
});

test("learning the same session twice counts it once", async () => {
  const { store } = await freshStore();
  await addLesson({ id: "once", title: "t", body: "b" });
  session(store, "r1", [["skill_auto_activated", { id: "once" }], proven]);
  await learnFromSession(store, "r1");
  await learnFromSession(store, "r1");
  assert.equal((await readLesson("once")).hits, 1);
  await addLesson({ id: "twice", title: "t", body: "b", confidence: 0.8 });
  session(store, "r2", [
    ["skill_auto_activated", { id: "twice" }],
    ["user_input", "no, please use pnpm in this repository"],
    proven,
  ]);
  await learnFromSession(store, "r2");
  await learnFromSession(store, "r2");
  assert.equal((await readLesson("twice")).confidence, 0.4);
});

test("an activated id that is not a lesson is ignored and the rest are still scored", async () => {
  const { store } = await freshStore();
  await addLesson({ id: "fine", title: "t", body: "b" });
  session(store, "e1", [
    ["skill_auto_activated", { id: "fine" }],
    ["skill_auto_activated", { id: "Not A Valid Id" }],
    proven,
  ]);
  const learning = await learnFromSession(store, "e1");
  assert.deepEqual(learning.confirmed, ["fine"]);
  assert.deepEqual(learning.errors, []);
});

test("repeated hook_response JSON and terminal escape codes are not signals", () => {
  const event = (eventId, type, data) => ({ eventId, type, data });
  const proven = event(1, "evidence", JSON.stringify({ result: "proven" }));
  const hook = JSON.stringify({
    type: "system",
    subtype: "hook_response",
    hook_name: "sessionstart:startup",
    exit_code: 0,
  });
  const noise = [
    proven,
    event(2, "json", hook),
    event(3, "json", hook),
    event(4, "text", "\u001b[?2026h\u001b[1;1h\u001b[j"),
    event(5, "text", "\u001b[?2026h\u001b[1;1h\u001b[j"),
  ];
  assert.deepEqual(detectSessionSignals(noise), []);
  const real = [
    proven,
    event(2, "text", "\u001b[1mran the build and it passed\u001b[0m"),
    event(3, "text", "ran the build and it passed"),
  ];
  assert.equal(detectSessionSignals(real)[0]?.signalType, "repeated-procedure");
});
