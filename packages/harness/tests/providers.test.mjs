import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateProfile } from "@ocean/core/domain/profiles/profile-validator.js";
import { SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { claudeSdkOptions } from "../dist/infrastructure/providers/claude-sdk.js";
import { resolveClientHome } from "../dist/infrastructure/providers/client-home.js";
import {
  buildProviderInvocation,
  providerAdapterRegistry,
  runProvider,
} from "../dist/infrastructure/providers/providers.js";

const unixOnly = process.platform === "win32" ? test.skip : test;

test("maps a Claude request onto Claude Agent SDK options, not CLI arguments", () => {
  const { env, ...options } = claudeSdkOptions(
    { provider: "claude", prompt: "hello", cwd: "/tmp", env: { ONLY: "1" } },
    "/opt/claude",
  );
  assert.deepEqual(options, {
    pathToClaudeCodeExecutable: "/opt/claude",
    cwd: path.resolve("/tmp"),
    systemPrompt: { type: "preset", preset: "claude_code" },
  });
  assert.equal(env.ONLY, "1");
  assert.equal(env.PATH, process.env.PATH);
  assert.throws(
    () =>
      buildProviderInvocation({ provider: "claude", prompt: "x", cwd: "/tmp" }),
    /runs through its SDK/,
  );
});

test("exposes one adapter with capabilities for every registered headless provider", () => {
  assert.deepEqual(Object.keys(providerAdapterRegistry).sort(), [
    "antigravity",
    "claude",
    "codex",
    "gemini",
    "hermes",
    "kilo",
    "kimi",
  ]);
  assert.ok(providerAdapterRegistry.claude.capabilities.includes("resume"));
});

test("builds the Codex JSON contract", () => {
  assert.deepEqual(
    buildProviderInvocation({
      provider: "codex",
      prompt: "hello",
      cwd: "/tmp",
    }),
    {
      command: "codex",
      args: ["exec", "--json", "--skip-git-repo-check", "hello"],
    },
  );
});

test("read-only provider invocations use enforced provider modes and fail closed when unsupported", () => {
  assert.deepEqual(
    buildProviderInvocation({
      provider: "codex",
      prompt: "inspect",
      cwd: "/tmp",
      readOnly: true,
    }).args.slice(0, 4),
    ["exec", "--sandbox", "read-only", "--json"],
  );
  const claude = claudeSdkOptions(
    { provider: "claude", prompt: "inspect", cwd: "/tmp", readOnly: true },
    "claude",
  );
  assert.equal(claude.permissionMode, "plan");
  assert.deepEqual(claude.extraArgs, { restricted: null });
  assert.ok(
    buildProviderInvocation({
      provider: "gemini",
      prompt: "inspect",
      cwd: "/tmp",
      readOnly: true,
    }).args.includes("--approval-mode=plan"),
  );
  assert.ok(
    buildProviderInvocation({
      provider: "antigravity",
      prompt: "inspect",
      cwd: "/tmp",
      readOnly: true,
    }).args.includes("--sandbox"),
  );
  assert.ok(
    buildProviderInvocation({
      provider: "kimi",
      prompt: "inspect",
      cwd: "/tmp",
      readOnly: true,
    }).args.includes("--plan"),
  );
  assert.throws(
    () =>
      buildProviderInvocation({
        provider: "hermes",
        prompt: "inspect",
        cwd: "/tmp",
        readOnly: true,
      }),
    /cannot enforce read-only/,
  );
  assert.throws(
    () =>
      buildProviderInvocation({
        provider: "kilo",
        prompt: "inspect",
        cwd: "/tmp",
        readOnly: true,
      }),
    /cannot enforce read-only/,
  );
});

test("builds the Gemini stream contract", () => {
  assert.deepEqual(
    buildProviderInvocation({
      provider: "gemini",
      prompt: "hello",
      cwd: "/tmp",
    }),
    {
      command: "gemini",
      args: ["--prompt", "hello", "--output-format", "stream-json"],
    },
  );
});

test("builds the Hermes one-shot contract", () => {
  assert.deepEqual(
    buildProviderInvocation({
      provider: "hermes",
      prompt: "hello",
      cwd: "/tmp",
    }),
    {
      command: "hermes",
      args: ["-z", "hello"],
    },
  );
});

test("builds the Kilo autonomous run contract", () => {
  assert.deepEqual(
    buildProviderInvocation({ provider: "kilo", prompt: "hello", cwd: "/tmp" }),
    {
      command: "kilo",
      args: ["run", "--auto", "hello"],
    },
  );
});

test("builds the Kimi non-interactive stream contract", () => {
  assert.deepEqual(
    buildProviderInvocation({ provider: "kimi", prompt: "hello", cwd: "/tmp" }),
    {
      command: "kimi",
      args: ["--prompt", "hello", "--print", "--output-format", "stream-json"],
    },
  );
});

test("accepts Gemini as a profile provider", () => {
  assert.equal(
    validateProfile({
      name: "gemini",
      provider: "gemini",
      model: "flash",
      role: "assistant",
    }).provider,
    "gemini",
  );
});

test("hands a Claude resume id to the SDK session", () => {
  const options = claudeSdkOptions(
    {
      provider: "claude",
      prompt: "continue",
      cwd: "/tmp",
      resumeId: "session-1",
    },
    "claude",
  );
  assert.equal(options.resume, "session-1");
  assert.equal(options.permissionMode, undefined);
});

unixOnly(
  "headless providers bypass Ocean shims and run the original executable",
  async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "ocean-headless-provider-"),
    );
    const shim = path.join(root, "shims");
    const staleShim = path.join(root, "old", "runtime", "shims");
    const bin = path.join(root, "bin");
    await mkdir(shim);
    await mkdir(staleShim, { recursive: true });
    await mkdir(bin);
    await writeFile(path.join(shim, "codex"), "#!/bin/sh\nexit 99\n");
    await chmod(path.join(shim, "codex"), 0o755);
    await writeFile(path.join(staleShim, "codex"), "#!/bin/sh\nexit 98\n");
    await chmod(path.join(staleShim, "codex"), 0o755);
    const original = path.join(bin, "codex");
    await writeFile(
      original,
      '#!/bin/sh\nprintf \'{"session_id":"codex-test"}\\n\'\n',
    );
    await chmod(original, 0o755);

    const previousRoot = process.env.OCEAN_ROOT;
    const previousShim = process.env.OCEAN_SHIM_DIR;
    const previousPath = process.env.PATH;
    process.env.OCEAN_ROOT = root;
    process.env.OCEAN_SHIM_DIR = shim;
    process.env.PATH = `${shim}${path.delimiter}${staleShim}${path.delimiter}${bin}`;
    try {
      const result = await runProvider({
        provider: "codex",
        prompt: "hello",
        cwd: root,
      });
      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.events[0], {
        type: "json",
        data: { session_id: "codex-test" },
      });
    } finally {
      if (previousRoot === undefined) delete process.env.OCEAN_ROOT;
      else process.env.OCEAN_ROOT = previousRoot;
      if (previousShim === undefined) delete process.env.OCEAN_SHIM_DIR;
      else process.env.OCEAN_SHIM_DIR = previousShim;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  },
);

test("resolves a configured client home only inside Ocean system/clients", () => {
  const previousRoot = process.env.OCEAN_ROOT;
  const root = path.join(os.tmpdir(), "ocean-client-home-test");
  process.env.OCEAN_ROOT = root;
  try {
    const profile = validateProfile({
      name: "developer",
      role: "developer",
      clients: {
        hermes: {
          enabled: true,
          home: `${SYSTEM_DIR}/clients/hermes/developer`,
        },
      },
    });
    assert.equal(
      resolveClientHome(profile),
      path.join(root, `${SYSTEM_DIR}/clients/hermes/developer`),
    );
    const unsafe = validateProfile({
      name: "bad",
      role: "assistant",
      clients: { hermes: { enabled: true, home: "../secrets" } },
    });
    assert.throws(
      () => resolveClientHome(unsafe),
      /must stay under Ocean system\/clients/,
    );
  } finally {
    if (previousRoot === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previousRoot;
  }
});
