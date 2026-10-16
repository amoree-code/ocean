import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import {
  clearHooks,
  registerHook,
} from "../dist/application/hooks/lifecycle-hooks.js";
import {
  isValidProviderSessionId,
  resumeAgent as resumeAgentRaw,
  runAgent as runAgentRaw,
} from "../dist/application/runs/run-agent.js";
import { createAgentRuntime } from "../dist/composition/runtime.js";
import { SessionStore } from "../dist/infrastructure/persistence/session-store.js";

// Test shim: the real runAgent/resumeAgent take an AgentRuntimeDeps bag; these
// wrap a bare provider-executor into a runtime with the real deps otherwise, so
// the test bodies keep passing just an executor.
const runAgent = (request, execute) =>
  runAgentRaw(
    request,
    createAgentRuntime(execute ? { executeProvider: execute } : {}),
  );
const resumeAgent = (sessionId, prompt, execute, runContract) =>
  resumeAgentRaw(
    sessionId,
    prompt,
    createAgentRuntime(execute ? { executeProvider: execute } : {}),
    runContract,
  );

test("bounds provider session identifiers before persistence", () => {
  assert.equal(isValidProviderSessionId("codex-session_1"), true);
  assert.equal(isValidProviderSessionId("../../private"), false);
  assert.equal(isValidProviderSessionId("x".repeat(257)), false);
});

test("rejects writable profiles without an approved run contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-policy-boundary-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "writer.json"),
    JSON.stringify({
      name: "writer",
      provider: "claude",
      model: "sonnet",
      role: "writer",
      writePolicy: "workspace",
    }),
  );
  process.env.OCEAN_ROOT = root;
  await assert.rejects(
    () =>
      runAgent(
        { profileName: "writer", prompt: "write", cwd: root },
        async () => ({ exitCode: 0, events: [], stderr: "" }),
      ),
    /approved run contract/,
  );
  delete process.env.OCEAN_ROOT;
});

test("allows an explicitly approved writable run contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-approved-write-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "writer.json"),
    JSON.stringify({
      name: "writer",
      provider: "claude",
      model: "sonnet",
      role: "writer",
      writePolicy: "workspace",
    }),
  );
  process.env.OCEAN_ROOT = root;
  try {
    const sessionId = "approved-write-session";
    const session = await runAgent(
      {
        sessionId,
        profileName: "writer",
        prompt: "write one bounded change",
        cwd: root,
        runContract: {
          runId: "approved-write-run",
          sessionId,
          profile: "writer",
          workingDirectory: root,
          allowedTools: [],
          deniedTools: [],
          stopConditions: ["verification failure"],
          approval: { required: true, approved: true },
          budget: { timeoutMs: 1000, maxAttempts: 1, maxOutputBytes: 10000 },
        },
      },
      async () => ({ exitCode: 0, events: [], stderr: "" }),
    );
    assert.equal(session.status, "completed");
  } finally {
    delete process.env.OCEAN_ROOT;
  }
});

test("approval-required profiles fail closed without an approved run contract", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ocean-approval-boundary-"),
  );
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "reviewed.json"),
    JSON.stringify({
      name: "reviewed",
      provider: "claude",
      role: "reviewer",
      governance: { approvalRequired: true },
    }),
  );
  process.env.OCEAN_ROOT = root;
  try {
    await assert.rejects(
      () =>
        runAgent(
          { profileName: "reviewed", prompt: "review", cwd: root },
          async () => ({ exitCode: 0, events: [], stderr: "" }),
        ),
      /requires an approved run contract/,
    );
  } finally {
    delete process.env.OCEAN_ROOT;
  }
});

test("connects profile, context, headless execution, and session storage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-agent-"));
  const profileDirectory = path.join(root, SYSTEM_DIR, "profiles", "reviewer");
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(
    path.join(profileDirectory, "profile.json"),
    JSON.stringify({
      name: "reviewer",
      provider: "claude",
      model: "sonnet",
      role: "review only",
      skills: ["verification"],
      allowedPaths: ["README.md"],
      contextSources: ["README.md"],
    }),
  );
  await writeFile(
    path.join(profileDirectory, "instructions.md"),
    "Inspect before reporting.",
  );
  await writeFile(path.join(root, "README.md"), "project context");
  const database = path.join(root, SYSTEM_DIR, "sessions", "sessions.sqlite");
  process.env.OCEAN_ROOT = root;
  const session = await runAgent(
    { profileName: "reviewer", prompt: "Review", cwd: root },
    async (request) => {
      assert.equal(request.provider, "claude");
      assert.match(request.prompt, /Inspect before reporting/);
      assert.match(request.prompt, /## Context references[\s\S]*README\.md/);
      assert.doesNotMatch(request.prompt, /project context/);
      assert.match(
        request.prompt,
        /- verification: Turn implementation claims.*verification[\\/]SKILL\.md/,
      );
      assert.ok(!request.prompt.includes("smallest runnable check"));
      request.onEvent?.({ type: "json", data: { text: "done" } });
      return { exitCode: 0, events: [], stderr: "" };
    },
  );

  const store = new SessionStore(database);
  assert.equal(session.status, "completed");
  assert.deepEqual(
    store.listEvents(session.sessionId).map((event) => event.type),
    [
      "session_entry_contract",
      "execution_plan",
      "user_input",
      "context_manifest",
      "context_cost",
      "json",
      "process_exit",
      "evidence",
      "session_summary",
    ],
  );
  assert.equal(session.closeoutStatus, "completed");
  assert.ok(session.summaryPath);
  store.close();
  delete process.env.OCEAN_ROOT;
});

test("redacts provider output, stderr, errors, and secrets near the payload bound", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-agent-redaction-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "default.json"),
    JSON.stringify({
      name: "default",
      provider: "claude",
      model: "sonnet",
      role: "assistant",
    }),
  );
  const database = path.join(root, SYSTEM_DIR, "sessions", "sessions.sqlite");
  const secret = `api_key=${"s".repeat(20)}`;
  process.env.OCEAN_ROOT = root;
  const session = await runAgent(
    { profileName: "default", prompt: "start", cwd: root },
    async (request) => {
      request.onEvent?.({
        type: "provider_output",
        data: "x".repeat(63_980) + secret,
      });
      return { exitCode: 1, events: [], stderr: secret };
    },
  );
  const store = new SessionStore(database);
  const events = store.listEvents(session.sessionId);
  assert.ok(events.every((event) => !event.data.includes(secret)));
  assert.ok(
    events
      .find((event) => event.type === "provider_output")
      .data.includes("[REDACTED]"),
  );
  assert.equal(
    JSON.parse(events.find((event) => event.type === "process_exit").data)
      .stderr,
    "[REDACTED]",
  );
  store.close();
  delete process.env.OCEAN_ROOT;

  process.env.OCEAN_ROOT = root;
  await assert.rejects(
    runAgent(
      { profileName: "default", prompt: "start", cwd: root },
      async () => {
        throw new Error(secret);
      },
    ),
    /api_key=/,
  );
  const failedStore = new SessionStore(database);
  const failedEvents = failedStore
    .list()
    .flatMap((item) => failedStore.listEvents(item.sessionId));
  assert.ok(failedEvents.every((event) => !event.data.includes(secret)));
  failedStore.close();
  delete process.env.OCEAN_ROOT;
});

test("applies one universal policy through every registered client adapter", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ocean-universal-profile-"),
  );
  const profileDirectory = path.join(root, SYSTEM_DIR, "profiles", "universal");
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(
    path.join(profileDirectory, "profile.json"),
    JSON.stringify({
      name: "universal",
      version: "2.0.0",
      role: "bounded verifier",
      clients: Object.fromEntries(
        ["claude", "codex", "gemini", "antigravity", "kimi"].map((client) => [
          client,
          { enabled: true, home: `${SYSTEM_DIR}/clients/homes/${client}` },
        ]),
      ),
      defaultClient: "claude",
      governance: {
        writePolicy: "none",
        allowedPaths: ["README.md"],
        approvalRequired: false,
      },
      verification: { commands: ["node --version"] },
    }),
  );
  process.env.OCEAN_ROOT = root;
  const seen = [];
  try {
    for (const client of ["claude", "codex", "gemini", "antigravity", "kimi"]) {
      const session = await runAgent(
        {
          profileName: "universal",
          client,
          prompt: "verify policy",
          cwd: root,
        },
        async (request) => {
          seen.push(request);
          return { exitCode: 0, events: [], stderr: "" };
        },
      );
      assert.equal(session.status, "completed");
      assert.equal(session.provider, client);
      assert.match(session.profileIdentity, /^[a-f0-9]{64}$/);
    }
  } finally {
    delete process.env.OCEAN_ROOT;
  }
  assert.deepEqual(
    seen.map((request) => request.provider),
    ["claude", "codex", "gemini", "antigravity", "kimi"],
  );
  assert.ok(seen.every((request) => request.readOnly === true));
  assert.ok(seen.every((request) => request.prompt.includes("verify policy")));
  assert.ok(
    seen.every((request) =>
      request.clientHome.endsWith(
        path.join(SYSTEM_DIR, "clients", "homes", request.provider),
      ),
    ),
  );
});

test("injects bounded profile facts into a run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-facts-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "default.json"),
    JSON.stringify({
      name: "default",
      provider: "claude",
      model: "sonnet",
      role: "assistant",
    }),
  );
  process.env.OCEAN_ROOT = root;
  const facts = path.join(root, SYSTEM_DIR, "memory", "profiles");
  await mkdir(facts, { recursive: true });
  await writeFile(
    path.join(facts, "default.json"),
    JSON.stringify([
      { key: "shell", value: "zsh", updatedAt: new Date().toISOString() },
    ]),
  );
  await runAgent(
    { profileName: "default", prompt: "start", cwd: root },
    async (request) => {
      assert.match(request.prompt, /shell: zsh/);
      return { exitCode: 0, events: [], stderr: "" };
    },
  );
  delete process.env.OCEAN_ROOT;
});

test("runs registered lifecycle hooks around a session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-hooks-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "default.json"),
    JSON.stringify({
      name: "default",
      provider: "claude",
      model: "sonnet",
      role: "assistant",
    }),
  );
  process.env.OCEAN_ROOT = root;
  const events = [];
  registerHook("session.start", (event) => events.push(event));
  registerHook("session.end", (event) => events.push(event));
  await runAgent(
    { profileName: "default", prompt: "start", cwd: root },
    async () => ({ exitCode: 0, events: [], stderr: "" }),
  );
  assert.deepEqual(events, ["session.start", "session.end"]);
  clearHooks();
  delete process.env.OCEAN_ROOT;
});

test("a throwing lifecycle hook blocks the run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-hook-block-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "default.json"),
    JSON.stringify({
      name: "default",
      provider: "claude",
      model: "sonnet",
      role: "assistant",
    }),
  );
  process.env.OCEAN_ROOT = root;
  registerHook("session.start", () => {
    throw new Error("blocked by hook");
  });
  await assert.rejects(
    () =>
      runAgent(
        { profileName: "default", prompt: "start", cwd: root },
        async () => ({ exitCode: 0, events: [], stderr: "" }),
      ),
    /blocked by hook/,
  );
  clearHooks();
  delete process.env.OCEAN_ROOT;
});

test("transitions status from created to running to completed, visible to a concurrent reader", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-status-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "default.json"),
    JSON.stringify({
      name: "default",
      provider: "claude",
      model: "sonnet",
      role: "assistant",
    }),
  );
  const database = path.join(root, SYSTEM_DIR, "sessions", "sessions.sqlite");
  process.env.OCEAN_ROOT = root;
  const sessionId = "status-check-session";
  const session = await runAgent(
    { profileName: "default", prompt: "start", cwd: root, sessionId },
    async () => {
      const reader = new SessionStore(database);
      const current = reader.get(sessionId);
      assert.equal(current.status, "running");
      reader.close();
      return { exitCode: 0, events: [], stderr: "" };
    },
  );
  assert.equal(session.status, "completed");
  delete process.env.OCEAN_ROOT;
});

test("resumes a Claude session using its provider session id", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-resume-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "default.json"),
    JSON.stringify({
      name: "default",
      provider: "claude",
      model: "sonnet",
      role: "assistant",
    }),
  );
  process.env.OCEAN_ROOT = root;
  const first = await runAgent(
    { profileName: "default", prompt: "start", cwd: root },
    async (request) => {
      request.onEvent?.({ type: "json", data: { session_id: "provider-1" } });
      return { exitCode: 0, events: [], stderr: "" };
    },
  );
  const resumed = await resumeAgent(
    first.sessionId,
    "continue",
    async (request) => {
      assert.equal(request.resumeId, "provider-1");
      return { exitCode: 0, events: [], stderr: "" };
    },
  );
  assert.equal(resumed.status, "completed");
  delete process.env.OCEAN_ROOT;
});

test("marks the session failed and records the error event when the provider throws", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-fail-throw-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "default.json"),
    JSON.stringify({
      name: "default",
      provider: "claude",
      model: "sonnet",
      role: "assistant",
    }),
  );
  const database = path.join(root, SYSTEM_DIR, "sessions", "sessions.sqlite");
  process.env.OCEAN_ROOT = root;

  await assert.rejects(
    runAgent(
      { profileName: "default", prompt: "start", cwd: root },
      async () => {
        throw new Error("provider crashed");
      },
    ),
    /provider crashed/,
  );

  const store = new SessionStore(database);
  const [session] = store.list();
  assert.equal(session.status, "failed");
  assert.deepEqual(
    store.listEvents(session.sessionId).map((event) => event.type),
    [
      "session_entry_contract",
      "execution_plan",
      "user_input",
      "context_manifest",
      "context_cost",
      "error",
      "session_summary",
    ],
  );
  store.close();
  delete process.env.OCEAN_ROOT;
});

test("marks the session failed when the provider exits non-zero without throwing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-fail-exit-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "default.json"),
    JSON.stringify({
      name: "default",
      provider: "claude",
      model: "sonnet",
      role: "assistant",
    }),
  );
  const database = path.join(root, SYSTEM_DIR, "sessions", "sessions.sqlite");
  process.env.OCEAN_ROOT = root;

  const session = await runAgent(
    { profileName: "default", prompt: "start", cwd: root },
    async () => {
      return { exitCode: 1, events: [], stderr: "boom" };
    },
  );

  assert.equal(session.status, "failed");
  const store = new SessionStore(database);
  const exitEvent = store
    .listEvents(session.sessionId)
    .find((event) => event.type === "process_exit");
  assert.deepEqual(JSON.parse(exitEvent.data), { exitCode: 1, stderr: "boom" });
  store.close();
  delete process.env.OCEAN_ROOT;
});

test("closes its session store exactly once, on both the success and failure paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-shutdown-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "default.json"),
    JSON.stringify({
      name: "default",
      provider: "claude",
      model: "sonnet",
      role: "assistant",
    }),
  );
  process.env.OCEAN_ROOT = root;

  const originalClose = SessionStore.prototype.close;
  let closeCalls = 0;
  SessionStore.prototype.close = function patchedClose(...args) {
    closeCalls += 1;
    return originalClose.apply(this, args);
  };

  try {
    await runAgent(
      { profileName: "default", prompt: "start", cwd: root },
      async () => {
        return { exitCode: 0, events: [], stderr: "" };
      },
    );
    assert.equal(closeCalls, 1);

    await assert.rejects(
      runAgent(
        { profileName: "default", prompt: "start", cwd: root },
        async () => {
          throw new Error("provider crashed");
        },
      ),
    );
    assert.equal(closeCalls, 2);
  } finally {
    SessionStore.prototype.close = originalClose;
    delete process.env.OCEAN_ROOT;
  }
});
