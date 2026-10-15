import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertValidStatusTransition } from "@ocean/core/domain/sessions/session.js";
import { SessionStore } from "../dist/infrastructure/persistence/session-store.js";
import { validateSession } from "../dist/infrastructure/persistence/session-validator.js";

async function openStore() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ocean-session-"));
  return new SessionStore(path.join(directory, "sessions.sqlite"));
}

test("stores a session and its events without extra application data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ocean-session-"));
  const store = new SessionStore(path.join(directory, "sessions.sqlite"));
  store.create({
    sessionId: "parent-1",
    provider: "claude",
    providerSessionId: null,
    parentSessionId: null,
    profile: "default",
    workingDirectory: directory,
    resumeData: null,
  });
  store.create({
    sessionId: "child-1",
    provider: "codex",
    providerSessionId: "codex-session",
    parentSessionId: "parent-1",
    profile: "reviewer",
    workingDirectory: directory,
    resumeData: null,
  });
  store.appendEvent("child-1", "completed", "review complete");

  assert.equal(store.get("child-1").parentSessionId, "parent-1");
  assert.deepEqual(
    store.listEvents("child-1").map((event) => event.type),
    ["completed"],
  );
  store.close();
});

test("stages user inputs as capture references without duplicating event content", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ocean-capture-"));
  const store = new SessionStore(path.join(directory, "sessions.sqlite"));
  store.create({
    sessionId: "capture-1",
    provider: "claude",
    providerSessionId: null,
    parentSessionId: null,
    profile: "default",
    workingDirectory: directory,
    resumeData: null,
  });
  const event = store.appendEvent(
    "capture-1",
    "user_input",
    "an idea worth reviewing",
  );
  assert.equal(store.scanCaptureItems("capture-1"), 1);
  assert.equal(store.scanCaptureItems("capture-1"), 0);
  const [item] = store.listCaptureItems();
  assert.deepEqual(item, {
    captureId: 1,
    sourceEventId: event.eventId,
    sessionId: "capture-1",
    content: "an idea worth reviewing",
    type: "unclassified",
    status: "new",
    target: null,
    createdAt: item.createdAt,
  });
  store.updateCaptureStatus(item.captureId, "promoted", "knowledge");
  assert.equal(store.listCaptureItems().length, 0);
  store.close();
});

test("allows the full valid lifecycle, including resuming a completed session", async () => {
  const store = await openStore();
  store.create({
    sessionId: "s1",
    provider: "claude",
    providerSessionId: null,
    parentSessionId: null,
    profile: "default",
    workingDirectory: "/tmp",
    resumeData: null,
  });
  assert.equal(store.get("s1").status, "created");

  store.updateStatus("s1", "running");
  store.updateStatus("s1", "completed");
  assert.equal(store.get("s1").status, "completed");

  // Resuming re-enters "running" from a completed run.
  store.updateStatus("s1", "running");
  store.updateStatus("s1", "failed");
  assert.equal(store.get("s1").status, "failed");

  // Retrying re-enters "running" from a failed run, and can end in cancelled.
  store.updateStatus("s1", "running");
  store.updateStatus("s1", "cancelled");
  assert.equal(store.get("s1").status, "cancelled");

  store.close();
});

test("rejects transitions that skip or leave the lifecycle contract", async () => {
  const store = await openStore();
  store.create({
    sessionId: "s2",
    provider: "claude",
    providerSessionId: null,
    parentSessionId: null,
    profile: "default",
    workingDirectory: "/tmp",
    resumeData: null,
  });

  assert.throws(
    () => store.updateStatus("s2", "completed"),
    /Invalid session status transition: created -> completed/,
  );
  assert.throws(
    () => store.updateStatus("s2", "cancelled"),
    /Invalid session status transition: created -> cancelled/,
  );

  store.updateStatus("s2", "running");
  store.updateStatus("s2", "cancelled");
  assert.throws(
    () => store.updateStatus("s2", "running"),
    /Invalid session status transition: cancelled -> running/,
  );

  store.close();
});

test("previews and reconciles stale running sessions without deleting their audit trail", async () => {
  const store = await openStore();
  store.create({
    sessionId: "stale-1",
    provider: "hermes",
    providerSessionId: null,
    parentSessionId: null,
    profile: "default",
    workingDirectory: "/tmp",
    resumeData: null,
  });
  store.updateStatus("stale-1", "running");
  const now = Date.now() + 2 * 60 * 60 * 1000;
  assert.equal(
    store
      .listStaleRunning(60 * 60 * 1000, now)
      .map((session) => session.sessionId)
      .join(),
    "stale-1",
  );
  const reconciled = store.reconcileStaleRunning(60 * 60 * 1000, now);
  assert.equal(reconciled.length, 1);
  assert.equal(store.get("stale-1").status, "cancelled");
  assert.equal(store.listEvents("stale-1").at(-1).type, "session_reconciled");
  assert.deepEqual(store.integrityCheck(), {
    integrity: "ok",
    foreignKeys: [],
  });
  store.close();
});

test("reconciling a stale running session signals its tracked provider process", async () => {
  const store = await openStore();
  store.create({
    sessionId: "stale-with-pid",
    provider: "hermes",
    providerSessionId: null,
    parentSessionId: null,
    profile: "default",
    workingDirectory: "/tmp",
    resumeData: null,
  });
  store.updateStatus("stale-with-pid", "running");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore",
  });
  await new Promise((resolve) => child.once("spawn", resolve));
  store.setProviderPid("stale-with-pid", child.pid);
  const exited = new Promise((resolve) => child.once("exit", resolve));

  const now = Date.now() + 2 * 60 * 60 * 1000;
  const reconciled = store.reconcileStaleRunning(60 * 60 * 1000, now);

  assert.equal(reconciled.length, 1);
  await exited;
  assert.equal(store.getProviderPid("stale-with-pid"), null);
  const lastEvent = JSON.parse(store.listEvents("stale-with-pid").at(-1).data);
  assert.equal(lastEvent.providerProcessSignaled, true);
  store.close();
});

test("reconciling a stale running session with no tracked pid does not throw", async () => {
  const store = await openStore();
  store.create({
    sessionId: "stale-no-pid",
    provider: "hermes",
    providerSessionId: null,
    parentSessionId: null,
    profile: "default",
    workingDirectory: "/tmp",
    resumeData: null,
  });
  store.updateStatus("stale-no-pid", "running");
  const now = Date.now() + 2 * 60 * 60 * 1000;
  const reconciled = store.reconcileStaleRunning(60 * 60 * 1000, now);
  assert.equal(reconciled.length, 1);
  const lastEvent = JSON.parse(store.listEvents("stale-no-pid").at(-1).data);
  assert.equal(lastEvent.providerProcessSignaled, false);
  store.close();
});

test("updateStatus rejects an unknown session id", async () => {
  const store = await openStore();
  assert.throws(
    () => store.updateStatus("missing", "running"),
    /Session not found: missing/,
  );
  store.close();
});

test("assertValidStatusTransition treats a same-status update as a no-op", () => {
  assert.doesNotThrow(() => assertValidStatusTransition("running", "running"));
  assert.doesNotThrow(() =>
    assertValidStatusTransition("cancelled", "cancelled"),
  );
});

test("validateSession rejects a malformed session record", () => {
  assert.throws(() =>
    validateSession({
      sessionId: "s3",
      provider: "claude",
      providerSessionId: null,
      parentSessionId: null,
      profile: "default",
      workingDirectory: "/tmp",
      status: "not-a-real-status",
      createdAt: "now",
      updatedAt: "now",
      resumeData: null,
    }),
  );
  assert.throws(() =>
    validateSession({
      sessionId: "",
      provider: "claude",
      providerSessionId: null,
      parentSessionId: null,
      profile: "default",
      workingDirectory: "/tmp",
      status: "created",
      createdAt: "now",
      updatedAt: "now",
      resumeData: null,
    }),
  );
});
