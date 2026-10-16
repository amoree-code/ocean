import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  enginePath,
  KNOWLEDGE_DIR,
  PERSONAL_DIR,
  PROJECTS_DIR,
  SYSTEM_DIR,
} from "@ocean/core/shared/paths.js";
import { loadProfile } from "../dist/infrastructure/filesystem/profile-loader.js";
import { loadRuntimeConfig } from "../dist/infrastructure/filesystem/runtime-config-loader.js";
import { setup } from "../dist/interfaces/cli/setup-command.js";

function platformStartupFile(home) {
  if (process.platform === "darwin") {
    return path.join(
      home,
      "Library",
      "LaunchAgents",
      "com.ocean.runtime.plist",
    );
  }
  if (process.platform === "linux") {
    return path.join(home, ".config", "systemd", "user", "ocean.service");
  }
  return path.join(
    home,
    "AppData",
    "Roaming",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    "ocean.cmd",
  );
}

test("setup isolates its writes to OCEAN_ROOT and the (fake) home directory, never the engine tree", async () => {
  const privateRoot = await mkdtemp(
    path.join(os.tmpdir(), "ocean-setup-root-"),
  );
  const fakeHome = await mkdtemp(path.join(os.tmpdir(), "ocean-setup-home-"));

  const originalOceanRoot = process.env.OCEAN_ROOT;
  const originalHome = process.env.HOME;
  const originalAppData = process.env.APPDATA;
  process.env.OCEAN_ROOT = privateRoot;
  process.env.HOME = fakeHome;
  if (process.platform === "win32")
    process.env.APPDATA = path.join(fakeHome, "AppData", "Roaming");

  try {
    await setup();

    for (const directory of [PERSONAL_DIR]) {
      const info = await stat(path.join(privateRoot, directory));
      assert.ok(
        info.isDirectory(),
        `expected ${directory} under the private root`,
      );
    }
    await stat(path.join(privateRoot, PERSONAL_DIR, "MEMORY.md"));
    await stat(path.join(privateRoot, KNOWLEDGE_DIR, "KNOWLEDGE.md"));
    for (const directory of [
      `${SYSTEM_DIR}/profiles`,
      `${SYSTEM_DIR}/sessions`,
      `${SYSTEM_DIR}/config/startup`,
      `${SYSTEM_DIR}/registry`,
      `${SYSTEM_DIR}/integrations`,
      `${SYSTEM_DIR}/archive`,
    ]) {
      const info = await stat(path.join(privateRoot, directory));
      assert.ok(
        info.isDirectory(),
        `expected ${directory} under the private root`,
      );
    }
    await stat(path.join(privateRoot, SYSTEM_DIR, "profiles", "default.json"));
    // T-245: setup writes the runtime config, which loads and names a v2 default profile.
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(privateRoot, SYSTEM_DIR, "config", "runtime.json"),
          "utf8",
        ),
      ),
      { schemaVersion: 1, defaultProfile: "default" },
    );
    assert.equal((await loadRuntimeConfig()).defaultProfile, "default");
    assert.equal((await loadProfile("default")).schemaVersion, 2);
    await assert.rejects(
      stat(
        path.join(
          privateRoot,
          SYSTEM_DIR,
          "profiles",
          "default",
          "profile.json",
        ),
      ),
    );

    const startupFile = platformStartupFile(fakeHome);
    const contents = await readFile(startupFile, "utf8");
    assert.ok(
      contents.includes(enginePath("dist", "main.js")),
      "startup entry should point at the engine executable",
    );
    assert.ok(
      contents.includes(privateRoot),
      "startup entry should use the private root as its working directory",
    );
  } finally {
    if (originalOceanRoot === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = originalOceanRoot;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
  }
});

async function setupAt(root, prepare) {
  const fakeHome = await mkdtemp(
    path.join(os.tmpdir(), "ocean-setup-folder-home-"),
  );
  if (prepare) await prepare(root);
  const saved = {
    root: process.env.OCEAN_ROOT,
    home: process.env.HOME,
    appData: process.env.APPDATA,
  };
  process.env.OCEAN_ROOT = root;
  process.env.HOME = fakeHome;
  if (process.platform === "win32")
    process.env.APPDATA = path.join(fakeHome, "AppData", "Roaming");
  try {
    await setup();
  } finally {
    for (const [key, name] of [
      ["root", "OCEAN_ROOT"],
      ["home", "HOME"],
      ["appData", "APPDATA"],
    ]) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
  }
}

test("setup creates the workspace project's tasks folder as ocean/ on a fresh root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-setup-fresh-"));
  await setupAt(root);
  await stat(path.join(root, PROJECTS_DIR, "ocean", "tasks"));
});
