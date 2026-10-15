import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registryFile } from "../dist/fs-utils.js";
import { loadProviderRegistry } from "../dist/infrastructure/providers/provider-registry.js";
import { setup } from "../dist/interfaces/cli/setup-command.js";
import { SYSTEM_DIR } from "../dist/paths.js";

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-registry-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "ocean-registry-home-"));
  const saved = {
    OCEAN_ROOT: process.env.OCEAN_ROOT,
    HOME: process.env.HOME,
    APPDATA: process.env.APPDATA,
  };
  process.env.OCEAN_ROOT = root;
  process.env.HOME = home;
  if (process.platform === "win32")
    process.env.APPDATA = path.join(home, "AppData", "Roaming");
  try {
    const legacy = path.join(root, SYSTEM_DIR, "control-plane", "registry");
    const current = path.join(root, SYSTEM_DIR, "registry");
    await mkdir(legacy, { recursive: true });
    await run({ legacy, current });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("reading the provider registry before setup carries the legacy file over, keeping custom providers", async () => {
  await withRoot(async ({ legacy, current }) => {
    const custom = {
      id: "foo",
      command: "foo",
      interactive: true,
      headless: false,
    };
    await writeFile(
      path.join(legacy, "providers.json"),
      JSON.stringify({ version: 1, providers: [custom] }),
    );

    const providers = loadProviderRegistry();

    assert.ok(providers.some((provider) => provider.id === "foo"));
    await stat(path.join(current, "providers.json"));
    await assert.rejects(stat(path.join(legacy, "providers.json")));
  });
});

test("an existing registry file is never overwritten by the legacy one", async () => {
  await withRoot(async ({ legacy, current }) => {
    await mkdir(current, { recursive: true });
    await writeFile(path.join(current, "project-bindings.json"), "new\n");
    await writeFile(path.join(legacy, "project-bindings.json"), "old\n");

    const file = registryFile("project-bindings.json");

    assert.equal(await readFile(file, "utf8"), "new\n");
    assert.equal(
      await readFile(path.join(legacy, "project-bindings.json"), "utf8"),
      "old\n",
    );
  });
});

test("setup carries every legacy registry file over", async () => {
  await withRoot(async ({ legacy, current }) => {
    await writeFile(path.join(legacy, "project-bindings.json"), "bindings\n");
    await writeFile(path.join(legacy, "installations.json"), "receipts\n");

    await setup();

    assert.equal(
      await readFile(path.join(current, "project-bindings.json"), "utf8"),
      "bindings\n",
    );
    assert.equal(
      await readFile(path.join(current, "installations.json"), "utf8"),
      "receipts\n",
    );
  });
});
