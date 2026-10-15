import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  applyRetention,
  planRetention,
  simulateRetention,
} from "../dist/application/sessions/session-retention.js";
import { SessionStore } from "../dist/infrastructure/persistence/session-store.js";
import { SYSTEM_DIR } from "../dist/paths.js";

const openStore = (file) => new SessionStore(file);

async function withFixtureStore(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-retention-"));
  await mkdir(path.join(root, SYSTEM_DIR, "sessions"), { recursive: true });
  const dbFile = path.join(root, SYSTEM_DIR, "sessions", "sessions.sqlite");
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  const store = new SessionStore(dbFile);
  try {
    return await fn({ root, dbFile, store });
  } finally {
    store.close();
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function backdate(dbFile, sessionId, iso) {
  const db = new DatabaseSync(dbFile);
  db.prepare(
    "UPDATE sessions SET updated_at = ?, closed_at = ? WHERE session_id = ?",
  ).run(iso, iso, sessionId);
  db.close();
}

function makeSession(store, id, { finish = true } = {}) {
  const session = store.create({
    sessionId: id,
    provider: "claude",
    providerSessionId: null,
    parentSessionId: null,
    profile: "default",
    workingDirectory: "/tmp",
    resumeData: null,
  });
  store.updateStatus(id, "running");
  if (finish) store.updateStatus(id, "completed");
  return session;
}

const OLD = "2020-01-01T00:00:00.000Z";

test("planRetention: running and created sessions are never eligible, regardless of age", () =>
  withFixtureStore(async ({ store, dbFile }) => {
    makeSession(store, "s-created", { finish: false });
    store.create({
      sessionId: "s-running",
      provider: "claude",
      providerSessionId: null,
      parentSessionId: null,
      profile: "default",
      workingDirectory: "/tmp",
      resumeData: null,
    });
    store.updateStatus("s-running", "running");
    backdate(dbFile, "s-created", OLD);
    backdate(dbFile, "s-running", OLD);
    const plan = planRetention(store, { keepDays: 1 });
    assert.ok(!plan.sessionIds.includes("s-created"));
    assert.ok(!plan.sessionIds.includes("s-running"));
  }));

test("planRetention: old finished sessions without a summary are flagged in needSummary", () =>
  withFixtureStore(async ({ store, dbFile }) => {
    makeSession(store, "s-old-1");
    backdate(dbFile, "s-old-1", OLD);
    const plan = planRetention(store, { keepDays: 1 });
    assert.ok(plan.sessionIds.includes("s-old-1"));
    assert.ok(plan.needSummary.includes("s-old-1"));
  }));

test("planRetention excludes events referenced by capture_items even when old and raw-typed", () =>
  withFixtureStore(async ({ store, dbFile }) => {
    makeSession(store, "s-cap");
    const event = store.appendEvent("s-cap", "provider_output", "output text");
    backdate(dbFile, "s-cap", OLD);
    const db = new DatabaseSync(dbFile);
    db.prepare(
      "INSERT INTO capture_items (source_event_id, created_at) VALUES (?, ?)",
    ).run(event.eventId, OLD);
    db.close();
    const plan = planRetention(store, { keepDays: 1 });
    assert.ok(!plan.eventIds.includes(event.eventId));
  }));

test("planRetention only ever selects provider_output/terminal_input events, never other types", () =>
  withFixtureStore(async ({ store, dbFile }) => {
    makeSession(store, "s-mixed");
    const raw = store.appendEvent("s-mixed", "provider_output", "raw");
    const other1 = store.appendEvent("s-mixed", "user_input", "hi");
    const other2 = store.appendEvent("s-mixed", "evidence", "{}");
    backdate(dbFile, "s-mixed", OLD);
    const plan = planRetention(store, { keepDays: 1 });
    assert.ok(plan.eventIds.includes(raw.eventId));
    assert.ok(!plan.eventIds.includes(other1.eventId));
    assert.ok(!plan.eventIds.includes(other2.eventId));
  }));

test("planRetention computes a fingerprint at real-corpus scale without a stack overflow", () =>
  withFixtureStore(async ({ store, dbFile }) => {
    // Regression for computeFingerprint's former `Math.max(...eventIds)`: spreading tens of
    // thousands of event ids as call arguments overflows the engine's argument-count limit.
    // A single fixture-scale event never hit this; the real sessions.sqlite (500k+ events)
    // did. 80,000 events, well past the real corpus's ~64k-event/7-day retention window.
    makeSession(store, "s-scale");
    // One transaction for all 80,000 inserts: each appendEvent call is its own implicit
    // commit, and 80,000 of those (each an fsync) is slow enough to blow past CI's per-test
    // timeout on a slower runner (observed on windows-latest) even though it's well within
    // a few seconds on a fast local disk.
    store.database.exec("BEGIN");
    try {
      for (let i = 0; i < 80_000; i += 1) {
        store.appendEvent("s-scale", "provider_output", "x");
      }
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }
    backdate(dbFile, "s-scale", OLD);
    const plan = planRetention(store, { keepDays: 1 });
    assert.equal(plan.eventIds.length, 80_000);
    assert.match(plan.fingerprint, /^[0-9a-f]{64}$/);
  }));

test("applyRetention refuses on a fingerprint mismatch", () =>
  withFixtureStore(async ({ store, dbFile }) => {
    makeSession(store, "s-fp");
    backdate(dbFile, "s-fp", OLD);
    const plan = planRetention(store, { keepDays: 1 });
    await assert.rejects(
      () => applyRetention(store, dbFile, plan, "not-the-real-fingerprint"),
      /fingerprint mismatch/,
    );
  }));

test("dry-run (planRetention alone) never touches the database file", () =>
  withFixtureStore(async ({ store, dbFile }) => {
    makeSession(store, "s-dry");
    backdate(dbFile, "s-dry", OLD);
    const before = await stat(dbFile);
    const beforeHash = createHash("sha256")
      .update(await readFile(dbFile))
      .digest("hex");
    planRetention(store, { keepDays: 1 });
    const after = await stat(dbFile);
    const afterHash = createHash("sha256")
      .update(await readFile(dbFile))
      .digest("hex");
    assert.equal(before.mtimeMs, after.mtimeMs);
    assert.equal(beforeHash, afterHash);
  }));

test("simulateRetention measures a copy and leaves the source database untouched", () =>
  withFixtureStore(async ({ store, dbFile }) => {
    for (let i = 0; i < 20; i += 1) {
      makeSession(store, `s-sim-${i}`);
      store.appendEvent(`s-sim-${i}`, "provider_output", "x".repeat(2000));
      backdate(dbFile, `s-sim-${i}`, OLD);
    }
    const beforeHash = createHash("sha256")
      .update(await readFile(dbFile))
      .digest("hex");
    const plan = planRetention(store, { keepDays: 1 });
    const result = await simulateRetention(store, dbFile, plan, openStore);
    assert.ok(result.afterBytes <= result.beforeBytes);
    const afterHash = createHash("sha256")
      .update(await readFile(dbFile))
      .digest("hex");
    assert.equal(
      beforeHash,
      afterHash,
      "source file must be unchanged by simulate",
    );
  }));

test("applyRetention: capture-referenced events, handoffs, ideas, and session row counts are unaffected", () =>
  withFixtureStore(async ({ store, dbFile }) => {
    makeSession(store, "s-apply-1");
    const rawEvent = store.appendEvent(
      "s-apply-1",
      "provider_output",
      "raw output",
    );
    const captureEvent = store.appendEvent(
      "s-apply-1",
      "provider_output",
      "captured output",
    );
    backdate(dbFile, "s-apply-1", OLD);
    const db = new DatabaseSync(dbFile);
    db.prepare(
      "INSERT INTO capture_items (source_event_id, created_at) VALUES (?, ?)",
    ).run(captureEvent.eventId, OLD);
    db.close();

    store.saveHandoff({ handoffId: "h-1", title: "Handoff" });
    store.saveIdea({ ideaId: "i-1", title: "Idea", content: "content" });

    const plan = planRetention(store, { keepDays: 1 });
    const result = await applyRetention(store, dbFile, plan, plan.fingerprint);

    assert.ok(result.eventsDeleted >= 1);
    assert.equal(store.listHandoffs().length, 1);
    assert.equal(store.listIdeas().length, 1);
    assert.equal(store.list().length, 1, "the session row itself must survive");
    assert.equal(store.get("s-apply-1").status, "completed");

    const remaining = store.listEvents("s-apply-1");
    assert.ok(
      remaining.some((event) => event.eventId === captureEvent.eventId),
      "capture-referenced event must survive",
    );
    assert.ok(
      !remaining.some((event) => event.eventId === rawEvent.eventId),
      "the unreferenced raw event must be pruned",
    );

    const dbAfter = new DatabaseSync(dbFile, { readOnly: true });
    const captureCount = dbAfter
      .prepare("SELECT COUNT(*) AS n FROM capture_items")
      .get().n;
    dbAfter.close();
    assert.equal(captureCount, 1, "capture_items row count is unaffected");
  }));

test("applyRetention summarizes unsummarized finished sessions before pruning their events", () =>
  withFixtureStore(async ({ store, dbFile }) => {
    makeSession(store, "s-summarize");
    store.appendEvent("s-summarize", "provider_output", "did some work");
    backdate(dbFile, "s-summarize", OLD);
    const plan = planRetention(store, { keepDays: 1 });
    assert.ok(plan.needSummary.includes("s-summarize"));
    const result = await applyRetention(store, dbFile, plan, plan.fingerprint);
    assert.ok(result.summarized.includes("s-summarize"));
    const after = store.get("s-summarize");
    assert.ok(after.summaryPath);
    const summaryFile = path.join(process.env.OCEAN_ROOT, after.summaryPath);
    const summaryContent = await readFile(summaryFile, "utf8");
    assert.ok(summaryContent.length > 0);
  }));

async function totalDbBytes(dbFile) {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += (await stat(`${dbFile}${suffix}`)).size;
    } catch {
      // file may not exist (e.g. no -wal after a checkpoint) — that's fine.
    }
  }
  return total;
}

test("applyRetention shrinks the fixture database (main+wal+shm) after checkpoint+VACUUM", () =>
  withFixtureStore(async ({ store, dbFile }) => {
    for (let i = 0; i < 50; i += 1) {
      makeSession(store, `s-shrink-${i}`);
      store.appendEvent(`s-shrink-${i}`, "provider_output", "y".repeat(5000));
      backdate(dbFile, `s-shrink-${i}`, OLD);
    }
    const beforeBytes = await totalDbBytes(dbFile);
    const plan = planRetention(store, { keepDays: 1 });
    await applyRetention(store, dbFile, plan, plan.fingerprint);
    const afterBytes = await totalDbBytes(dbFile);
    assert.ok(
      afterBytes < beforeBytes,
      `expected shrink: ${beforeBytes} -> ${afterBytes}`,
    );
  }));

test("non-raw event types (session_entry_contract, evidence, user_input) always survive retention", () =>
  withFixtureStore(async ({ store, dbFile }) => {
    makeSession(store, "s-nonraw");
    const contract = store.appendEvent(
      "s-nonraw",
      "session_entry_contract",
      "{}",
    );
    const evidence = store.appendEvent("s-nonraw", "evidence", "{}");
    const userInput = store.appendEvent("s-nonraw", "user_input", "hello");
    backdate(dbFile, "s-nonraw", OLD);
    const plan = planRetention(store, { keepDays: 1 });
    await applyRetention(store, dbFile, plan, plan.fingerprint);
    const remaining = store
      .listEvents("s-nonraw")
      .map((event) => event.eventId);
    assert.ok(remaining.includes(contract.eventId));
    assert.ok(remaining.includes(evidence.eventId));
    assert.ok(remaining.includes(userInput.eventId));
  }));
