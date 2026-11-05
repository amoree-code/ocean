import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSupportedPlatform,
  findInstallSpec,
  installPlan,
  installProvider,
  listInstallSpecs,
  removeInstalledProvider,
} from "../dist/application/install/provider-installer.js";

test("catalog exposes provider-neutral install recipes for AI clients", () => {
  const ids = listInstallSpecs().map((spec) => spec.provider.id);
  assert.deepEqual(ids, [
    "claude",
    "codex",
    "gemini",
    "kilo",
    "kimi",
    "hermes",
  ]);
  assert.equal(
    installPlan("kimi").installer,
    "uv tool install --force --python 3.13 kimi-cli",
  );
  assert.equal(findInstallSpec("hermes").provider.command, "hermes");
});

test("installation fails closed until explicit approval", async () => {
  await assert.rejects(
    installProvider("hermes", false),
    /Installation approval required\. Re-run with: ocean install hermes --yes/,
  );
});

test("unknown clients fail closed before any installer runs", () => {
  assert.throws(
    () => findInstallSpec("unknown-client"),
    /No approved installer/,
  );
  assert.throws(
    () => installPlan("https://example.com/install.sh"),
    /No approved installer/,
  );
});

test("unsupported platforms fail before installer execution", () => {
  assert.throws(
    () => assertSupportedPlatform(findInstallSpec("hermes"), "aix"),
    /not supported on platform: aix/,
  );
});

test("remove requires approval and does not promise credential deletion", async () => {
  await assert.rejects(
    removeInstalledProvider("hermes", false),
    /Removal approval required/,
  );
});
