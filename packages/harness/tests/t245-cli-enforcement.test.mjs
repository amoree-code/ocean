// T-245 Phase 3 — the execution plan reaches the CLI: model flag, child-only environment,
// and sandbox policy enforced before spawn.
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { selectProfileClient } from "@ocean/core/domain/profiles/profile.js";
import { validateProfile } from "@ocean/core/domain/profiles/profile-validator.js";
import { SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { runAgent } from "../dist/application/runs/run-agent.js";
import { createAgentRuntime } from "../dist/composition/runtime.js";
import { SessionStore } from "../dist/infrastructure/persistence/session-store.js";
import { buildProviderInvocation } from "../dist/infrastructure/providers/providers.js";

const unixOnly = process.platform === "win32" ? test.skip : test;

const profile = (name, model, overrides = {}) => ({
  schemaVersion: 2,
  name,
  role: "developer",
  defaultClient: "claude",
  clients: { claude: { enabled: true, model } },
  governance: { sandbox: { mode: "read-only", network: "provider-only" } },
  memory: { enabled: true, scope: "profile" },
  ...overrides,
});

// A fake `claude` on PATH: it records its argv per profile and echoes the plan variables it
// received, after a pause so two runs overlap.
async function withFakeClaude(profiles, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "t245-cli-"));
  const bin = path.join(root, "bin");
  const argsDir = path.join(root, "args");
  await mkdir(bin);
  await mkdir(argsDir);
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  for (const item of profiles)
    await writeFile(
      path.join(root, SYSTEM_DIR, "profiles", `${item.name}.json`),
      JSON.stringify(item),
    );
  const fake = path.join(bin, "claude");
  await writeFile(
    fake,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$@" > "$T245_ARGS_DIR/$OCEAN_CURRENT_PROFILE.args"',
      "sleep 0.3",
      'printf \'{"profile":"%s","provider":"%s","model":"%s","scope":"%s"}\\n\' "$OCEAN_CURRENT_PROFILE" "$OCEAN_TARGET_PROVIDER" "$OCEAN_TARGET_MODEL" "$OCEAN_MEMORY_SCOPE"',
      "",
    ].join("\n"),
  );
  await chmod(fake, 0o755);
  const saved = {
    OCEAN_ROOT: process.env.OCEAN_ROOT,
    PATH: process.env.PATH,
    T245_ARGS_DIR: process.env.T245_ARGS_DIR,
    OCEAN_CURRENT_PROFILE: process.env.OCEAN_CURRENT_PROFILE,
    OCEAN_TARGET_MODEL: process.env.OCEAN_TARGET_MODEL,
  };
  process.env.OCEAN_ROOT = root;
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.T245_ARGS_DIR = argsDir;
  // Ambient values a parent session might leave behind; the plan must override them.
  process.env.OCEAN_CURRENT_PROFILE = "ambient";
  process.env.OCEAN_TARGET_MODEL = "ambient-model";
  try {
    return await fn({ root, argsDir });
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  }
}

function recordedEcho(root, sessionId) {
  const store = new SessionStore(
    path.join(root, SYSTEM_DIR, "sessions", "sessions.sqlite"),
  );
  try {
    const event = store
      .listEvents(sessionId)
      .find((item) => item.type === "json");
    return JSON.parse(event.data);
  } finally {
    store.close();
  }
}

unixOnly(
  "two parallel profiles each get only their own model, environment and memory namespace",
  async () => {
    await withFakeClaude(
      [profile("alpha", "model-a"), profile("beta", "model-b")],
      async ({ root, argsDir }) => {
        const runtime = createAgentRuntime();
        const [alpha, beta] = await Promise.all(
          ["alpha", "beta"].map((name) =>
            runAgent({ profileName: name, prompt: "go", cwd: root }, runtime),
          ),
        );
        assert.equal(alpha.status, "completed");
        assert.equal(beta.status, "completed");
        assert.deepEqual(recordedEcho(root, alpha.sessionId), {
          profile: "alpha",
          provider: "claude",
          model: "model-a",
          scope: "alpha",
        });
        assert.deepEqual(recordedEcho(root, beta.sessionId), {
          profile: "beta",
          provider: "claude",
          model: "model-b",
          scope: "beta",
        });
        for (const [name, own, other] of [
          ["alpha", "model-a", "model-b"],
          ["beta", "model-b", "model-a"],
        ]) {
          const args = (
            await readFile(path.join(argsDir, `${name}.args`), "utf8")
          )
            .trimEnd()
            .split("\n");
          assert.equal(args[args.indexOf("--model") + 1], own);
          assert.ok(!args.includes(other));
          // Read-only is enforced with the client's own flags.
          assert.ok(
            args.includes("--permission-mode") && args.includes("plan"),
          );
        }
        // Nothing was written back to this process's environment.
        assert.equal(process.env.OCEAN_CURRENT_PROFILE, "ambient");
        assert.equal(process.env.OCEAN_TARGET_MODEL, "ambient-model");
        assert.equal(process.env.OCEAN_MEMORY_SCOPE, undefined);
      },
    );
  },
);

test("a network policy the client cannot enforce fails before any session or process", async () => {
  for (const sandbox of [
    { mode: "read-only", network: "deny" },
    { mode: "read-only", network: "allowlist", allowedHosts: ["example.com"] },
  ])
    await withFakeClaude(
      [profile("strict", "m", { governance: { sandbox } })],
      async ({ root, argsDir }) => {
        let executed = false;
        await assert.rejects(
          runAgent(
            { profileName: "strict", prompt: "go", cwd: root },
            createAgentRuntime({
              executeProvider: async () => {
                executed = true;
                return { exitCode: 0, events: [], stderr: "" };
              },
            }),
          ),
          new RegExp(`cannot enforce network policy: ${sandbox.network}`),
        );
        assert.equal(executed, false);
        await assert.rejects(readFile(path.join(argsDir, "strict.args")), {
          code: "ENOENT",
        });
      },
    );
});

test("a client that cannot enforce read-only fails before spawn", async () => {
  await withFakeClaude(
    [
      profile("loose", "m", {
        defaultClient: "kilo",
        clients: { kilo: { enabled: true, model: "x/y" } },
      }),
    ],
    async ({ root }) => {
      let executed = false;
      await assert.rejects(
        runAgent(
          { profileName: "loose", prompt: "go", cwd: root },
          createAgentRuntime({
            executeProvider: async () => {
              executed = true;
              return { exitCode: 0, events: [], stderr: "" };
            },
          }),
        ),
        /cannot enforce read-only execution: kilo/,
      );
      assert.equal(executed, false);
    },
  );
});

test("a v1 profile's own model is never passed to another client", () => {
  // The shape of the shipped templates and live profiles: a Claude model, other clients
  // enabled without one.
  const profile = validateProfile({
    name: "default",
    role: "r",
    clients: {
      claude: { enabled: true, model: "sonnet" },
      codex: { enabled: true },
    },
  });
  assert.equal(selectProfileClient(profile).model, "sonnet");
  const codex = selectProfileClient(profile, "codex");
  assert.equal(codex.model, "provider-managed");
  const { args } = buildProviderInvocation({
    provider: "codex",
    prompt: "hi",
    cwd: "/tmp",
    model: codex.model,
  });
  assert.ok(!args.includes("--model") && !args.includes("sonnet"));
  const single = validateProfile({
    name: "single",
    role: "r",
    provider: "codex",
    model: "gpt-5",
  });
  assert.equal(selectProfileClient(single).model, "gpt-5");
});
