// T-245 Phase 2 — profile schema v2 and the immutable execution plan.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeProfileFact } from "../dist/application/memory/profile-facts.js";
import { runAgent } from "../dist/application/runs/run-agent.js";
import { createAgentRuntime } from "../dist/composition/runtime.js";
import {
  profileIdentity,
  selectProfileClient,
} from "../dist/domain/profiles/profile.js";
import { validateProfile } from "../dist/domain/profiles/profile-validator.js";
import {
  buildExecutionPlan,
  executionPlanIdentity,
} from "../dist/domain/runs/execution-plan.js";
import { SessionStore } from "../dist/infrastructure/persistence/session-store.js";
import { SYSTEM_DIR } from "../dist/paths.js";

const cli = { cwd: "/work", supportedTransports: ["cli"], writeAllowed: false };

const v2 = (overrides = {}) => ({
  schemaVersion: 2,
  name: "coder",
  role: "developer",
  defaultClient: "claude",
  clients: {
    claude: { enabled: true, model: "sonnet", temperature: 0.2 },
    codex: { enabled: true, model: "gpt-5" },
    gemini: { enabled: false },
  },
  governance: {
    writePolicy: "workspace",
    allowedPaths: ["."],
    sandbox: { mode: "workspace-write", network: "provider-only" },
  },
  memory: { enabled: true, scope: "profile" },
  ...overrides,
});

// ---- schema v2 -----------------------------------------------------------------------------

test("a complete v2 profile parses and keeps its sandbox and binding fields", () => {
  const profile = validateProfile(v2());
  assert.equal(profile.schemaVersion, 2);
  assert.equal(profile.clients.claude.temperature, 0.2);
  assert.deepEqual(profile.governance.sandbox, {
    mode: "workspace-write",
    network: "provider-only",
    allowedHosts: [],
  });
});

test("a profile without schemaVersion is v1 and needs none of the v2 fields", () => {
  const profile = validateProfile({
    name: "legacy",
    role: "r",
    provider: "claude",
    memory: { enabled: true, scope: "free-form" },
  });
  assert.equal(profile.schemaVersion, 1);
  assert.equal(profile.model, "provider-managed");
});

test("v2 rejects what v1 left implicit", () => {
  const cases = [
    [{ defaultClient: undefined }, /requires a defaultClient/],
    [{ defaultClient: "gemini" }, /defaultClient must be an enabled client/],
    [{ clients: { claude: { enabled: true } } }, /Schema v2 requires a model/],
    [{ memory: { enabled: true, scope: "team" } }, /memory.scope/],
    [{ governance: { writePolicy: "none" } }, /Schema v2 requires a sandbox/],
    [
      {
        governance: {
          sandbox: { mode: "read-only", network: "allowlist" },
        },
      },
      /allowlist needs hosts/,
    ],
    [
      {
        governance: {
          writePolicy: "none",
          sandbox: { mode: "workspace-write", network: "deny" },
        },
      },
      /workspace-write conflicts/,
    ],
    [
      { clients: { claude: { enabled: true, model: "m", temperature: 2.5 } } },
      /temperature/,
    ],
    [
      {
        clients: {
          claude: { enabled: true, model: "m", transport: "smoke-signal" },
        },
      },
      /transport/,
    ],
  ];
  for (const [overrides, pattern] of cases)
    assert.throws(() => validateProfile(v2(overrides)), pattern);
});

// ---- profile identity ----------------------------------------------------------------------

test("a v1 profile's identity is unchanged by schema v2", () => {
  const profile = validateProfile({
    name: "legacy",
    role: "r",
    provider: "claude",
    model: "sonnet",
    clients: { claude: { enabled: true, model: "sonnet" } },
  });
  // The pre-v2 canonical form, field for field.
  const before = {
    name: profile.name,
    description: profile.description,
    version: profile.version,
    provider: profile.provider,
    model: profile.model,
    role: profile.role,
    skills: profile.skills,
    allowedPaths: profile.allowedPaths,
    allowedCommands: profile.allowedCommands,
    writePolicy: profile.writePolicy,
    contextSources: profile.contextSources,
    clients: {
      claude: {
        enabled: true,
        model: "sonnet",
        capabilities: [],
        limitations: [],
      },
    },
    defaultClient: profile.defaultClient,
    memory: profile.memory,
    verification: profile.verification,
    contextCompression: profile.contextCompression,
    instructions: profile.instructions,
  };
  assert.equal(
    profileIdentity(profile),
    createHash("sha256").update(JSON.stringify(before)).digest("hex"),
  );
});

test("a v2 profile's identity covers its sandbox", () => {
  const a = validateProfile(v2());
  const b = validateProfile(
    v2({
      governance: {
        writePolicy: "workspace",
        allowedPaths: ["."],
        sandbox: { mode: "read-only", network: "provider-only" },
      },
    }),
  );
  assert.notEqual(profileIdentity(a), profileIdentity(b));
});

// ---- execution plan ------------------------------------------------------------------------

test("client precedence: explicit request, then defaultClient; the model comes from the binding", () => {
  const profile = validateProfile(v2());
  const byDefault = buildExecutionPlan(selectProfileClient(profile), cli);
  assert.equal(byDefault.client, "claude");
  assert.equal(byDefault.model, "sonnet");
  assert.equal(byDefault.temperature, 0.2);
  const explicit = buildExecutionPlan(
    selectProfileClient(profile, "codex"),
    cli,
  );
  assert.equal(explicit.client, "codex");
  assert.equal(explicit.model, "gpt-5");
  assert.equal("temperature" in explicit, false);
});

test("a disabled client fails closed before a plan exists", () => {
  assert.throws(
    () => selectProfileClient(validateProfile(v2()), "gemini"),
    /not enabled for profile/,
  );
});

test("a binding on a transport this runtime cannot execute fails closed", () => {
  const profile = validateProfile(
    v2({
      clients: {
        claude: {
          enabled: true,
          model: "deepseek-chat",
          transport: "openai-compatible-api",
        },
      },
    }),
  );
  assert.throws(
    () => buildExecutionPlan(selectProfileClient(profile), cli),
    /Unsupported transport for client claude: openai-compatible-api/,
  );
  assert.equal(
    buildExecutionPlan(selectProfileClient(profile), {
      ...cli,
      supportedTransports: ["cli", "openai-compatible-api"],
    }).transport,
    "openai-compatible-api",
  );
});

test("plan identity is deterministic and tracks every resolved value", () => {
  const profile = selectProfileClient(validateProfile(v2()));
  const a = buildExecutionPlan(profile, cli);
  const b = buildExecutionPlan(profile, cli);
  assert.match(executionPlanIdentity(a), /^[0-9a-f]{64}$/);
  assert.equal(executionPlanIdentity(a), executionPlanIdentity(b));
  // Key order does not matter, only values.
  const reordered = Object.fromEntries(Object.entries(a).reverse());
  assert.equal(executionPlanIdentity(reordered), executionPlanIdentity(a));
  for (const changed of [
    buildExecutionPlan(profile, { ...cli, cwd: "/elsewhere" }),
    buildExecutionPlan(profile, { ...cli, writeAllowed: true }),
    buildExecutionPlan(
      selectProfileClient(validateProfile(v2()), "codex"),
      cli,
    ),
  ])
    assert.notEqual(executionPlanIdentity(changed), executionPlanIdentity(a));
});

test("the plan is immutable", () => {
  const plan = buildExecutionPlan(
    selectProfileClient(validateProfile(v2())),
    cli,
  );
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.sandbox));
  assert.ok(Object.isFrozen(plan.sandbox.allowedPaths));
  assert.ok(Object.isFrozen(plan.childEnv));
  assert.throws(() => {
    plan.model = "other";
  }, TypeError);
});

test("the sandbox is the strictest of profile policy and what the run may write", () => {
  const writable = selectProfileClient(validateProfile(v2()));
  assert.equal(buildExecutionPlan(writable, cli).sandbox.mode, "read-only");
  assert.equal(buildExecutionPlan(writable, cli).readOnly, true);
  const granted = buildExecutionPlan(writable, { ...cli, writeAllowed: true });
  assert.equal(granted.sandbox.mode, "workspace-write");
  assert.equal(granted.readOnly, false);
  const readOnly = selectProfileClient(
    validateProfile(
      v2({
        governance: { sandbox: { mode: "read-only", network: "deny" } },
      }),
    ),
  );
  const plan = buildExecutionPlan(readOnly, { ...cli, writeAllowed: true });
  assert.equal(plan.sandbox.mode, "read-only");
  assert.equal(plan.sandbox.network, "deny");
});

test("a v1 profile maps to the sandbox its write policy implied", () => {
  const plan = buildExecutionPlan(
    selectProfileClient(
      validateProfile({
        name: "legacy",
        role: "r",
        provider: "claude",
        writePolicy: "workspace",
      }),
    ),
    { ...cli, writeAllowed: true },
  );
  assert.equal(plan.sandbox.mode, "workspace-write");
  assert.equal(plan.sandbox.network, "provider-only");
  assert.equal(plan.model, "provider-managed");
});

test("the memory namespace is the profile name, or null when memory is off", () => {
  const on = buildExecutionPlan(
    selectProfileClient(validateProfile(v2())),
    cli,
  );
  assert.equal(on.memoryNamespace, "coder");
  assert.equal(on.childEnv.OCEAN_MEMORY_SCOPE, "coder");
  for (const memory of [
    { enabled: true, scope: "disabled" },
    { enabled: false, scope: "profile" },
  ]) {
    const off = buildExecutionPlan(
      selectProfileClient(validateProfile(v2({ memory }))),
      cli,
    );
    assert.equal(off.memoryNamespace, null);
    assert.equal(off.childEnv.OCEAN_MEMORY_SCOPE, "disabled");
  }
  assert.deepEqual(on.childEnv, {
    OCEAN_CURRENT_PROFILE: "coder",
    OCEAN_TARGET_PROVIDER: "claude",
    OCEAN_TARGET_MODEL: "sonnet",
    OCEAN_MEMORY_SCOPE: "coder",
  });
});

// ---- session audit -------------------------------------------------------------------------

async function withProfile(profile, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "t245-plan-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", `${profile.name}.json`),
    JSON.stringify(profile),
  );
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    return await fn(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

const readOnlyV2 = (overrides = {}) =>
  v2({
    governance: { sandbox: { mode: "read-only", network: "provider-only" } },
    ...overrides,
  });

test("a run records its execution plan and identity before any context or process", async () => {
  await withProfile(readOnlyV2(), async (root) => {
    let request;
    const session = await runAgent(
      { profileName: "coder", prompt: "plan", cwd: root, client: "codex" },
      createAgentRuntime({
        executeProvider: async (value) => {
          request = value;
          return { exitCode: 0, events: [], stderr: "" };
        },
      }),
    );
    const store = new SessionStore(
      path.join(root, SYSTEM_DIR, "sessions", "sessions.sqlite"),
    );
    try {
      const events = store.listEvents(session.sessionId);
      assert.deepEqual(
        events.slice(0, 3).map((event) => event.type),
        ["session_entry_contract", "execution_plan", "user_input"],
      );
      const recorded = JSON.parse(
        events.find((event) => event.type === "execution_plan").data,
      );
      assert.equal(recorded.identity, executionPlanIdentity(recorded.plan));
      assert.equal(recorded.plan.client, "codex");
      assert.equal(recorded.plan.model, "gpt-5");
      assert.equal(recorded.plan.memoryNamespace, "coder");
      assert.equal(recorded.plan.profileIdentity, session.profileIdentity);
      assert.equal(recorded.plan.cwd, root);
      assert.equal(request.readOnly, recorded.plan.readOnly);
      assert.equal(request.provider, "codex");
    } finally {
      store.close();
    }
  });
});

test("an unsupported transport is refused before a session is created", async () => {
  await withProfile(
    readOnlyV2({
      clients: {
        claude: {
          enabled: true,
          model: "deepseek-chat",
          transport: "openai-compatible-api",
        },
      },
    }),
    async (root) => {
      let executed = false;
      await assert.rejects(
        runAgent(
          { profileName: "coder", prompt: "plan", cwd: root },
          createAgentRuntime({
            executeProvider: async () => {
              executed = true;
              return { exitCode: 0, events: [], stderr: "" };
            },
          }),
        ),
        /Unsupported transport/,
      );
      assert.equal(executed, false);
    },
  );
});

test("a profile with memory disabled gets no facts in its prompt", async () => {
  await withProfile(
    readOnlyV2({ memory: { enabled: true, scope: "disabled" } }),
    async (root) => {
      await writeProfileFact("coder", "secret-plan", "do not show");
      let prompt = "";
      await runAgent(
        { profileName: "coder", prompt: "plan", cwd: root },
        createAgentRuntime({
          executeProvider: async (request) => {
            prompt = request.prompt;
            return { exitCode: 0, events: [], stderr: "" };
          },
        }),
      );
      assert.doesNotMatch(prompt, /secret-plan|Durable profile facts/);
    },
  );
});
