import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function seen(env, names) {
  const script = `console.log(JSON.stringify(${JSON.stringify(names)}.map((n) => process.env[n] ?? null)))`;
  return JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "./tests/clear-ocean-env.mjs", "-e", script],
      { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" },
    ),
  );
}

test("the preload clears inherited OCEAN_* workspace variables", () => {
  const [root, shim] = seen(
    {
      OCEAN_ROOT: "/inherited/ocean",
      OCEAN_SHIM_DIR: "/inherited/shims",
    },
    ["OCEAN_ROOT", "OCEAN_SHIM_DIR"],
  );
  assert.notEqual(root, "/inherited/ocean");
  assert.equal(shim, null);
});

test("the preload points OCEAN_ROOT at an empty sandbox of its own, never the inherited root", () => {
  const script = `const fs = require("node:fs"); console.log(JSON.stringify([process.env.OCEAN_ROOT, fs.readdirSync(process.env.OCEAN_ROOT).length]))`;
  const run = () =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ["--import", "./tests/clear-ocean-env.mjs", "-e", script],
        {
          env: { PATH: process.env.PATH, OCEAN_ROOT: "/inherited/ocean" },
          encoding: "utf8",
        },
      ),
    );
  const [first, entries] = run();
  const [second] = run();
  assert.notEqual(first, "/inherited/ocean");
  assert.match(path.basename(first), /^ocean-test-root-/);
  assert.equal(entries, 0);
  assert.notEqual(first, second);
  assert.equal(existsSync(first), false, "the sandbox is removed on exit");
});

test("the preload keeps the opt-in test gates a developer sets on purpose", () => {
  const gates = [
    "LIVE_PROVIDER_TESTS",
    "LIVE_EMBEDDER_TESTS",
    "BROWSER_INTEGRATION",
  ];
  const names = gates.map((gate) => `OCEAN_${gate}`);
  const kept = seen(
    Object.fromEntries(names.map((name) => [name, "1"])),
    names,
  );
  assert.deepEqual(
    kept,
    names.map(() => "1"),
  );
});
