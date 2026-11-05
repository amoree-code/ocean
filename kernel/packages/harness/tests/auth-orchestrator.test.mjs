import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  authAdapter,
  authLogin,
  authStatus,
} from "../dist/application/auth/auth-orchestrator.js";
import { defaultAuthDeps } from "../dist/composition/runtime.js";

const unixOnly = process.platform === "win32" ? test.skip : test;

async function withFakeProvider(command, script, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-auth-"));
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  const executable = path.join(bin, command);
  await writeFile(executable, `#!/bin/sh\n${script}\n`);
  await chmod(executable, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ""}`;
  try {
    await run();
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
}

test("exposes only provider-owned auth adapters", () => {
  assert.equal(authAdapter("codex").command, "codex");
  assert.equal(authAdapter("kilo").command, "kilo");
  assert.equal(
    authAdapter("claude").statusArgs.join(" "),
    "auth status --json",
  );
});

test("reports unsupported auth without invoking a client", async () => {
  assert.equal(await authStatus("hermes", defaultAuthDeps), "not_supported");
});

unixOnly(
  "recognizes an already-authenticated Claude status response",
  async () => {
    await withFakeProvider(
      "claude",
      'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then printf \'{"loggedIn":true}\\n\'; exit 0; fi',
      async () => {
        assert.equal(
          await authStatus("claude", defaultAuthDeps),
          "authenticated",
        );
      },
    );
  },
);

unixOnly(
  "reports failed provider status and failed login without exposing output",
  async () => {
    await withFakeProvider(
      "kilo",
      "printf 'login failed\n' >&2; exit 1",
      async () => {
        assert.equal(await authStatus("kilo", defaultAuthDeps), "failed");
        assert.equal(await authLogin("kilo", defaultAuthDeps), "failed");
      },
    );
  },
);

unixOnly("cancels and times out the official login flow", async () => {
  await withFakeProvider("kilo", "sleep 5", async () => {
    assert.equal(
      await authLogin("kilo", defaultAuthDeps, { timeoutMs: 25 }),
      "cancelled",
    );
    const controller = new AbortController();
    const pending = authLogin("kilo", defaultAuthDeps, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 25);
    assert.equal(await pending, "cancelled");
  });
});
