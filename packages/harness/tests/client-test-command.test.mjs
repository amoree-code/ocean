import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { enginePath, oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";

// SYSTEM_DIR may itself contain a path separator (e.g. "kernel/bridge"), so each of
// its own segments needs the same [\\/] class as the literal segments around it.
const sep = "[\\\\/]";
const systemPattern = SYSTEM_DIR.split("/").join(sep);

test("client test reports Ocean sources and Claude transport", () => {
  const result = spawnSync(
    process.execPath,
    [path.resolve("dist/main.js"), "client", "test", "claude", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.provider, "claude");
  assert.match(report.transport, /bootstrap-env/);
  assert.ok(report.ocean.bootstrapBytes <= 256);
  // Pre-rename keys are still emitted for one release, with identical values.
  assert.equal(report.ocean.root, oceanPath());
  assert.equal(report.routing.oceanEngine, enginePath("dist", "main.js"));
  assert.ok(report.project);
  assert.ok(Array.isArray(report.providerOwnedPaths));
  assert.equal(report.routing.command, "claude");
  assert.match(
    report.routing.shim,
    new RegExp(
      `${sep}${systemPattern}${sep}runtime${sep}shims${sep}ocean-claude(?:\\.cmd)?$`,
    ),
  );
  assert.match(
    report.ocean.sessionStore,
    new RegExp(`${sep}${systemPattern}${sep}sessions${sep}sessions\\.sqlite$`),
  );
});

test("client test without a provider reports every registered client", () => {
  const result = spawnSync(
    process.execPath,
    [path.resolve("dist/main.js"), "client", "test", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  const reports = JSON.parse(result.stdout);
  assert.ok(Array.isArray(reports));
  assert.ok(reports.some((report) => report.provider === "claude"));
  assert.ok(reports.some((report) => report.provider === "codex"));
  assert.ok(
    reports.every((report) =>
      new RegExp(`${sep}${systemPattern}${sep}runtime${sep}shims${sep}`).test(
        report.routing.shim,
      ),
    ),
  );
});
