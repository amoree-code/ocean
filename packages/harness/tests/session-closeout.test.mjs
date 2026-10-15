import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { finalizeSession } from "../dist/application/memory/session-closeout.js";
import { SessionStore } from "../dist/infrastructure/persistence/session-store.js";
import { DAILY_DIR, INBOX_DIR, SYSTEM_DIR } from "../dist/paths.js";

// Each test uses a fresh temp OCEAN_ROOT, so at most one brain-dump file
// exists at a time — no need to match by session id, which (deliberately)
// no longer appears in the filename.
async function readBrainDump(root) {
  const files = await readdir(path.join(root, INBOX_DIR, "brain-dump")).catch(
    () => [],
  );
  if (!files.length) return null;
  return readFile(path.join(root, INBOX_DIR, "brain-dump", files[0]), "utf8");
}

test("finalizes a session with a bounded human summary, metadata, and handoff", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-session-closeout-"));
  process.env.OCEAN_ROOT = root;
  await mkdir(path.join(root, SYSTEM_DIR, "sessions"), { recursive: true });
  const store = new SessionStore(
    path.join(root, SYSTEM_DIR, "sessions", "sessions.sqlite"),
  );
  const sessionId = "closeout-session-1";
  store.create({
    sessionId,
    title: "Closeout test",
    taskId: null,
    handoffId: null,
    provider: "claude",
    providerSessionId: null,
    parentSessionId: null,
    profile: "reviewer",
    profileIdentity: "profile-hash",
    workingDirectory: root,
    resumeData: null,
  });
  store.updateStatus(sessionId, "running");
  store.appendEvent(
    sessionId,
    "user_input",
    "Review the session closeout behavior",
  );
  const providerSecret = ["sk", "-ant-closeout-secret"].join("");
  store.appendEvent(
    sessionId,
    "provider_output",
    `Inspected the session flow and found one bounded result. ${providerSecret}`,
  );
  store.appendEvent(sessionId, "process_exit", JSON.stringify({ exitCode: 0 }));
  store.appendEvent(
    sessionId,
    "evidence",
    JSON.stringify({
      result: "proven",
      criterion: "provider process exits successfully",
    }),
  );
  store.updateStatus(sessionId, "completed");

  const result = await finalizeSession(store, sessionId, { exitCode: 0 });
  const summary = await readFile(path.join(root, result.summaryPath), "utf8");
  const saved = store.get(sessionId);

  const today = new Date().toISOString().slice(0, 10);
  const daily = await readFile(
    path.join(root, DAILY_DIR, `${today}.md`),
    "utf8",
  );
  assert.match(daily, /^# Daily/);
  assert.match(daily, /## Work log/);
  assert.match(daily, /Review the session closeout behavior/);
  assert.doesNotMatch(daily, new RegExp(providerSecret));

  assert.match(summary, /# Session Summary/);
  assert.match(summary, /Review the session closeout behavior/);
  assert.match(summary, /Inspected the session flow/);
  assert.doesNotMatch(summary, new RegExp(providerSecret));
  assert.match(summary, /## Next action/);

  const brainDump = await readBrainDump(root);
  assert.match(brainDump, /# Review the session closeout behavior/);
  assert.doesNotMatch(brainDump, new RegExp(providerSecret));
  assert.match(brainDump, /Session id: closeout-session-1/);

  assert.equal(saved.summaryPath, result.summaryPath);
  assert.equal(saved.summaryHash, result.summaryHash);
  assert.ok(saved.summaryBytes > 0);
  assert.equal(saved.closeoutStatus, "completed");
  assert.ok(saved.handoffId);
  assert.equal(store.getHandoff(saved.handoffId).sourceSessionId, sessionId);
  assert.ok(
    store
      .listEvents(sessionId)
      .some((event) => event.type === "session_summary"),
  );
  const second = await finalizeSession(store, sessionId, { exitCode: 0 });
  assert.equal(second.summaryPath, result.summaryPath);
  assert.equal(
    store
      .listEvents(sessionId)
      .filter((event) => event.type === "session_summary").length,
    1,
  );
  assert.equal(store.listHandoffs().length, 1);

  // A second closeout for an already-closed-out session must not append a
  // duplicate "Work log" line to the daily narrative (the bug this guards
  // against: a caller's success path closes out, then a later step in the
  // same caller throws and its catch block calls finalizeSession again).
  const dailyAfterSecond = await readFile(
    path.join(root, DAILY_DIR, `${today}.md`),
    "utf8",
  );
  assert.equal(
    dailyAfterSecond.split("\n").filter((line) => line.startsWith("- ")).length,
    1,
  );

  store.close();
  delete process.env.OCEAN_ROOT;
});

test("skips the daily Work log line and the brain-dump for a generic, no-project session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-session-closeout-"));
  process.env.OCEAN_ROOT = root;
  await mkdir(path.join(root, SYSTEM_DIR, "sessions"), { recursive: true });
  const store = new SessionStore(
    path.join(root, SYSTEM_DIR, "sessions", "sessions.sqlite"),
  );
  const sessionId = "closeout-session-generic";
  store.create({
    sessionId,
    title: "claude session",
    taskId: null,
    handoffId: null,
    provider: "claude",
    providerSessionId: null,
    parentSessionId: null,
    profile: "reviewer",
    profileIdentity: "profile-hash",
    workingDirectory: root, // plain tmp dir: no .git, so no real project
    resumeData: null,
  });
  store.updateStatus(sessionId, "running");
  store.appendEvent(sessionId, "process_exit", JSON.stringify({ exitCode: 0 }));
  store.updateStatus(sessionId, "completed");

  await finalizeSession(store, sessionId, { exitCode: 0 });

  const today = new Date().toISOString().slice(0, 10);
  const dailyPath = path.join(root, DAILY_DIR, `${today}.md`);
  let daily = "";
  try {
    daily = await readFile(dailyPath, "utf8");
  } catch {
    // No daily file at all is also an acceptable outcome of skipping.
  }
  assert.doesNotMatch(daily, /## Work log\n- /);
  assert.doesNotMatch(daily, /claude session/);

  const brainDump = await readBrainDump(root);
  assert.equal(brainDump, null);

  store.close();
  delete process.env.OCEAN_ROOT;
});

test("still logs a generic-title session and its brain-dump when it has a real git project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-session-closeout-"));
  process.env.OCEAN_ROOT = root;
  await mkdir(path.join(root, SYSTEM_DIR, "sessions"), { recursive: true });
  const projectDir = path.join(root, "project");
  await mkdir(path.join(projectDir, ".git"), { recursive: true });
  const store = new SessionStore(
    path.join(root, SYSTEM_DIR, "sessions", "sessions.sqlite"),
  );
  const sessionId = "closeout-session-real-project";
  store.create({
    sessionId,
    title: "claude session",
    taskId: null,
    handoffId: null,
    provider: "claude",
    providerSessionId: null,
    parentSessionId: null,
    profile: "reviewer",
    profileIdentity: "profile-hash",
    workingDirectory: projectDir,
    resumeData: null,
  });
  store.updateStatus(sessionId, "running");
  store.appendEvent(sessionId, "process_exit", JSON.stringify({ exitCode: 0 }));
  store.updateStatus(sessionId, "completed");

  await finalizeSession(store, sessionId, { exitCode: 0 });

  const today = new Date().toISOString().slice(0, 10);
  const daily = await readFile(
    path.join(root, DAILY_DIR, `${today}.md`),
    "utf8",
  );
  assert.match(daily, /## Work log\n- .*claude session — completed/);

  const brainDump = await readBrainDump(root);
  assert.match(brainDump, /^# project/);
  assert.match(brainDump, /Session id: closeout-session-real-project/);

  store.close();
  delete process.env.OCEAN_ROOT;
});
