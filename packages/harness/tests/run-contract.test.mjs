import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertRunCanStart,
  validateRunContract,
} from "@ocean/core/domain/runs/run-contract.js";
import { authorizeRun } from "../dist/application/runs/run-authorization.js";
import { SessionStore } from "../dist/infrastructure/persistence/session-store.js";

const contract = (overrides = {}) =>
  validateRunContract({
    runId: "run-1",
    sessionId: "session-1",
    profile: "default",
    workingDirectory: "/tmp/project",
    allowedTools: ["read"],
    deniedTools: ["write"],
    stopConditions: ["provider exits", "timeout"],
    approval: { required: true, approved: true },
    budget: { timeoutMs: 1000, maxAttempts: 2, maxOutputBytes: 1000 },
    ...overrides,
  });

test("run contracts fail closed for invalid scope, approval, and budget", () => {
  assert.throws(
    () => contract({ allowedTools: ["write"], deniedTools: ["write"] }),
    /both allowed and denied/,
  );
  assert.throws(
    () =>
      assertRunCanStart(
        contract({ approval: { required: true, approved: false } }),
      ),
    /approval required/,
  );
  assert.throws(() => assertRunCanStart(contract(), 3), /attempt limit/);
});

test("approval and refusal decisions persist as session events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-run-contract-"));
  const store = new SessionStore(path.join(root, "sessions.sqlite"));
  store.create({
    sessionId: "session-1",
    provider: "claude",
    providerSessionId: null,
    parentSessionId: null,
    profile: "default",
    workingDirectory: root,
    resumeData: null,
  });
  authorizeRun(
    store,
    contract({ sessionId: "session-1", workingDirectory: root }),
  );
  assert.deepEqual(JSON.parse(store.listEvents("session-1")[0].data), {
    runId: "run-1",
    approved: true,
    attempt: 1,
  });
  assert.throws(
    () =>
      authorizeRun(
        store,
        contract({
          sessionId: "session-1",
          workingDirectory: root,
          approval: { required: true, approved: false },
        }),
      ),
    /approval required/,
  );
  assert.equal(store.listEvents("session-1")[1].type, "run_refusal");
  store.close();
});

test("run contracts are bound to the session profile and working directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-run-scope-"));
  const store = new SessionStore(path.join(root, "sessions.sqlite"));
  store.create({
    sessionId: "session-1",
    provider: "claude",
    providerSessionId: null,
    parentSessionId: null,
    profile: "default",
    workingDirectory: root,
    resumeData: null,
  });
  assert.throws(
    () =>
      authorizeRun(
        store,
        contract({
          sessionId: "session-1",
          profile: "other",
          workingDirectory: root,
        }),
      ),
    /profile does not match/,
  );
  assert.throws(
    () =>
      authorizeRun(
        store,
        contract({ sessionId: "session-1", workingDirectory: "/elsewhere" }),
      ),
    /working directory does not match/,
  );
  store.close();
});
