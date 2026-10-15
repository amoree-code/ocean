import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyIntent } from "../dist/application/context/intent-router.js";
import {
  buildSessionPointer,
  planSessionResume,
  validateParentSession,
  validateSessionIdentifier,
} from "../dist/application/sessions/session-pointer.js";
import { openSessionStore } from "../dist/infrastructure/persistence/session-store.js";
import { SYSTEM_DIR } from "../dist/paths.js";

const BUDGET = {
  maxFiles: 10,
  maxBytes: 50_000,
  maxChars: 5_000,
  maxOperationCost: 5,
};

async function withStore(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-slice8-"));
  await mkdir(path.join(root, SYSTEM_DIR, "sessions"), { recursive: true });
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  const store = await openSessionStore();
  try {
    return await fn(store, root);
  } finally {
    store.close();
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

function createSession(store, overrides = {}) {
  const sessionId = overrides.sessionId ?? randomUUID();
  store.create({
    sessionId,
    title: "test session",
    taskId: overrides.taskId ?? null,
    handoffId: null,
    provider: overrides.provider ?? "claude",
    providerSessionId: null,
    parentSessionId: overrides.parentSessionId ?? null,
    profile: "intercepted:claude",
    profileIdentity: "test",
    workingDirectory: overrides.workingDirectory ?? "/tmp",
    resumeData: null,
  });
  if (overrides.status && overrides.status !== "created") {
    store.updateStatus(sessionId, "running");
    if (overrides.status !== "running")
      store.updateStatus(sessionId, overrides.status);
  }
  return sessionId;
}

// ---------------------------------------------------------------- identifier validation

test("valid pointer: a real session identifier resolves to a compact pointer", () =>
  withStore(async (store, root) => {
    const sessionId = createSession(store, {
      status: "running",
      workingDirectory: root,
      taskId: "T-198",
    });
    const plan = await planSessionResume(store, sessionId, BUDGET, {
      cwd: root,
    });
    assert.equal(plan.ok, true, plan.reason);
    assert.equal(plan.mode, "attach-child");
    assert.equal(plan.pointer.sessionId, sessionId);
    assert.equal(plan.pointer.taskId, "T-198");
    assert.equal(plan.parentSessionId, sessionId);
  }));

test("missing pointer is refused without touching the store", () =>
  withStore(async (store) => {
    for (const missing of [null, undefined, ""]) {
      const plan = await planSessionResume(store, missing, BUDGET);
      assert.equal(plan.ok, false, String(missing));
      assert.equal(plan.pointer, null);
    }
  }));

test("malformed pointer shapes are refused before any lookup", () => {
  for (const bad of [
    "not-a-uuid",
    "../../etc/passwd",
    "abc\0def",
    "12345",
    "'; DROP TABLE sessions;--",
  ]) {
    assert.equal(validateSessionIdentifier(bad).valid, false, bad);
  }
  assert.equal(validateSessionIdentifier(randomUUID()).valid, true);
});

test("unknown session is reported as non-existent, never guessed", () =>
  withStore(async (store) => {
    const plan = await planSessionResume(store, randomUUID(), BUDGET);
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /does not exist in Ocean/);
  }));

// ---------------------------------------------------------------- status handling

test("closed (completed) session yields a pointer-only plan and is never reopened", () =>
  withStore(async (store, root) => {
    const sessionId = createSession(store, {
      status: "completed",
      workingDirectory: root,
    });
    const before = store.get(sessionId).status;
    const plan = await planSessionResume(store, sessionId, BUDGET, {
      cwd: root,
    });
    assert.equal(plan.ok, true, plan.reason);
    assert.equal(plan.mode, "pointer-only");
    assert.equal(
      store.get(sessionId).status,
      before,
      "resume planning must not mutate session status",
    );
  }));

test("terminal statuses (failed, cancelled) refuse resume — no resurrection, no reassignment", () =>
  withStore(async (store, root) => {
    for (const status of ["failed", "cancelled"]) {
      const sessionId = createSession(store, {
        status,
        workingDirectory: root,
      });
      const plan = await planSessionResume(store, sessionId, BUDGET, {
        cwd: root,
      });
      assert.equal(plan.ok, false, status);
      assert.match(plan.reason, /terminal status/);
      assert.equal(
        store.get(sessionId).status,
        status,
        "status must be unchanged",
      );
    }
  }));

test("a session that never started is refused", () =>
  withStore(async (store, root) => {
    const sessionId = createSession(store, {
      status: "created",
      workingDirectory: root,
    });
    const plan = await planSessionResume(store, sessionId, BUDGET, {
      cwd: root,
    });
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /never started/);
  }));

test("stale running session is refused with an explicit stale reason", () =>
  withStore(async (store, root) => {
    const sessionId = createSession(store, {
      status: "running",
      workingDirectory: root,
    });
    const future = Date.now() + 48 * 60 * 60 * 1000;
    const plan = await planSessionResume(store, sessionId, BUDGET, {
      cwd: root,
      now: future,
    });
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /stale/);
    assert.deepEqual(plan.violations, ["stale-session"]);
    assert.equal(
      store.get(sessionId).status,
      "running",
      "a stale session must not be mutated",
    );
  }));

// ---------------------------------------------------------------- parent / child

test("parent/child relation is recorded through the existing session store", () =>
  withStore(async (store, root) => {
    const parentId = createSession(store, {
      status: "running",
      workingDirectory: root,
    });
    const childId = createSession(store, {
      status: "running",
      workingDirectory: root,
      parentSessionId: parentId,
    });
    assert.equal(store.get(childId).parentSessionId, parentId);
    const pointer = await buildSessionPointer(store.get(childId));
    assert.equal(pointer.parentSessionId, parentId);
  }));

test("an invalid or unknown parent is refused, and a missing parent is never guessed", () =>
  withStore(async (store, root) => {
    const sessionId = createSession(store, {
      status: "running",
      workingDirectory: root,
    });
    assert.deepEqual(validateParentSession(store, null), {
      ok: true,
      parentSessionId: null,
    });
    assert.deepEqual(validateParentSession(store, undefined), {
      ok: true,
      parentSessionId: null,
    });
    assert.equal(validateParentSession(store, "not-a-uuid").ok, false);
    assert.equal(validateParentSession(store, randomUUID()).ok, false);
    assert.equal(
      validateParentSession(store, sessionId, sessionId).ok,
      false,
      "self-parent must be refused",
    );
    assert.deepEqual(validateParentSession(store, sessionId), {
      ok: true,
      parentSessionId: sessionId,
    });
  }));

// ---------------------------------------------------------------- project scope

test("cross-project resume is refused when the session belongs to another project", () =>
  withStore(async (store, root) => {
    const sessionId = createSession(store, {
      status: "running",
      workingDirectory: root,
    });
    const plan = await planSessionResume(store, sessionId, BUDGET, {
      cwd: root,
      requestedProject: "some-other-project",
    });
    assert.equal(plan.ok, false);
    assert.match(plan.reason, /cross-project resume refused/);
  }));

test("resuming with the workspace project's id is not a cross-project resume", () =>
  withStore(async (store, root) => {
    const sessionId = createSession(store, {
      status: "running",
      workingDirectory: root,
    });
    for (const requestedProject of ["ocean"]) {
      const plan = await planSessionResume(store, sessionId, BUDGET, {
        cwd: root,
        requestedProject,
      });
      assert.doesNotMatch(plan.reason ?? "", /cross-project/, requestedProject);
    }
  }));

test("a session outside any project binding resolves projectId null rather than guessing", () =>
  withStore(async (store, root) => {
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "ocean-slice8-outside-"),
    );
    const sessionId = createSession(store, {
      status: "running",
      workingDirectory: outside,
    });
    const plan = await planSessionResume(store, sessionId, BUDGET, {
      cwd: root,
    });
    assert.equal(plan.pointer.projectId, null);
  }));

// ---------------------------------------------------------------- bounds and budget

test("resume metadata is bounded: no transcript, no event content, clipped next action", () =>
  withStore(async (store, root) => {
    const sessionId = createSession(store, {
      status: "running",
      workingDirectory: root,
    });
    store.appendEvent(
      sessionId,
      "provider_output",
      "SECRET-TRANSCRIPT-MARKER repeated ".repeat(200),
    );
    const plan = await planSessionResume(store, sessionId, BUDGET, {
      cwd: root,
    });
    const serialized = JSON.stringify(plan);
    assert.doesNotMatch(serialized, /SECRET-TRANSCRIPT-MARKER/);
    assert.ok(
      serialized.length < 1_000,
      `pointer should stay compact, was ${serialized.length}`,
    );
    assert.deepEqual(Object.keys(plan.pointer).sort(), [
      "checkpointRef",
      "nextAction",
      "parentSessionId",
      "projectId",
      "provider",
      "sessionId",
      "status",
      "taskId",
      "updatedAt",
    ]);
  }));

test("invalid budget blocks resume planning before the store is read", () =>
  withStore(async (store, root) => {
    const sessionId = createSession(store, {
      status: "running",
      workingDirectory: root,
    });
    for (const budget of [
      undefined,
      null,
      { ...BUDGET, maxChars: 0 },
      { ...BUDGET, maxBytes: -5 },
    ]) {
      const plan = await planSessionResume(store, sessionId, budget, {
        cwd: root,
      });
      assert.equal(plan.ok, false);
      assert.match(plan.reason, /invalid-budget/);
    }
  }));

test("a resume plan larger than budget.maxChars is refused rather than trimmed silently", () =>
  withStore(async (store, root) => {
    const sessionId = createSession(store, {
      status: "running",
      workingDirectory: root,
    });
    const plan = await planSessionResume(
      store,
      sessionId,
      { ...BUDGET, maxChars: 1 },
      { cwd: root },
    );
    assert.equal(plan.ok, false);
    assert.deepEqual(plan.violations, ["max-chars-exceeded"]);
  }));

// ---------------------------------------------------------------- determinism & isolation

test("deterministic resume: repeated identical requests return identical plans", () =>
  withStore(async (store, root) => {
    const sessionId = createSession(store, {
      status: "completed",
      workingDirectory: root,
    });
    const now = Date.now();
    const first = await planSessionResume(store, sessionId, BUDGET, {
      cwd: root,
      now,
    });
    const second = await planSessionResume(store, sessionId, BUDGET, {
      cwd: root,
      now,
    });
    assert.deepEqual(first, second);
  }));

test("a duplicate resume request creates nothing and changes no session state", () =>
  withStore(async (store, root) => {
    const sessionId = createSession(store, {
      status: "completed",
      workingDirectory: root,
    });
    const before = store.list().length;
    const beforeRow = store.get(sessionId);
    await planSessionResume(store, sessionId, BUDGET, { cwd: root });
    await planSessionResume(store, sessionId, BUDGET, { cwd: root });
    assert.equal(
      store.list().length,
      before,
      "resume planning must not create sessions",
    );
    assert.deepEqual(store.get(sessionId), beforeRow);
  }));

test("sequential plans for different sessions do not leak state between calls", () =>
  withStore(async (store, root) => {
    const running = createSession(store, {
      status: "running",
      workingDirectory: root,
    });
    const failed = createSession(store, {
      status: "failed",
      workingDirectory: root,
    });
    const first = await planSessionResume(store, running, BUDGET, {
      cwd: root,
    });
    const second = await planSessionResume(store, failed, BUDGET, {
      cwd: root,
    });
    const third = await planSessionResume(store, running, BUDGET, {
      cwd: root,
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(third.ok, true);
    assert.equal(third.pointer.sessionId, running);
  }));

// ---------------------------------------------------------------- isolation guarantees

test("session-pointer.ts imports no provider, network, or MCP module and invokes no provider", async () => {
  const source = await readFile(
    path.resolve("src/application/sessions/session-pointer.ts"),
    "utf8",
  );
  const imports = [...source.matchAll(/^import .*?from "([^"]+)";?$/gm)].map(
    (match) => match[1],
  );
  const allowed = new Set([
    "node:path",
    "@ocean/core/domain/ports/session-store-port.js",
    "@ocean/core/domain/sessions/session.js",
    "../context/context-ladder.js",
    "../context/project-resolution.js",
    // Pure path/project-id helpers (sameProject); no provider, network or MCP code.
    "../../paths.js",
  ]);
  for (const specifier of imports)
    assert.ok(allowed.has(specifier), `unexpected import: ${specifier}`);
  const codeOnly = source
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(
    codeOnly,
    /node:https?|node:net\b|child_process|mcp-client|mcp-server|fetch\(|spawn|exec\(/i,
  );
});

test("no accidental content persistence: planning writes nothing to the session database", () =>
  withStore(async (store, root) => {
    const sessionId = createSession(store, {
      status: "running",
      workingDirectory: root,
    });
    const beforeEvents = store.listEvents(sessionId).length;
    await planSessionResume(store, sessionId, BUDGET, { cwd: root });
    assert.equal(
      store.listEvents(sessionId).length,
      beforeEvents,
      "resume planning must not append events",
    );
  }));

// ---------------------------------------------------------------- language parity

test("Arabic and English continue-wording both fail closed: neither language ever guesses a session", () =>
  withStore(async (store, root) => {
    const english = classifyIntent("continue the login work");
    const arabic = classifyIntent("كمل شغل اللوكين");
    assert.equal(english.confidence, "medium");
    assert.equal(arabic.action, english.action);
    assert.ok(
      arabic.ambiguityReason && english.ambiguityReason,
      "both languages must stay ambiguous without an explicit id",
    );
    // Neither classification carries a session identifier, so neither can drive a resume.
    for (const classification of [english, arabic]) {
      const plan = await planSessionResume(
        store,
        classification.identifier,
        BUDGET,
        { cwd: root },
      );
      assert.equal(plan.ok, false);
    }
  }));
