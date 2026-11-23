import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MEMORY_AUTHORITY_LINE } from "@ocean/core/domain/mcp/memory-contract.js";
import {
  DESKTOP_PLUGIN_NAME,
  desktopOrgPluginsDir,
  desktopPluginFiles,
  desktopPluginInstalled,
  installDesktopPlugin,
  zipStored,
} from "../dist/application/clients/desktop-plugin.js";

const temp = () => mkdtemp(path.join(os.tmpdir(), "ocean-desktop-plugin-"));
// The zip fallback writes under the Ocean root; keep it out of the real one.
process.env.OCEAN_ROOT = await temp();

test("the Desktop plugin installs itself, is hook-only, and its start message is the shared authority line", () => {
  const files = desktopPluginFiles("9.9.9");
  assert.deepEqual(Object.keys(files).sort(), [
    ".claude-plugin/plugin.json",
    "hooks/hooks.json",
    "hooks/session-start.json",
    "version.json",
  ]);
  const manifest = JSON.parse(files[".claude-plugin/plugin.json"]);
  assert.equal(manifest.name, DESKTOP_PLUGIN_NAME);
  assert.equal(manifest.version, "9.9.9");
  // Desktop installs a "required" organization plugin with no user step, and hides Uninstall.
  assert.equal(manifest.installationPreference, "required");
  assert.deepEqual(JSON.parse(files["version.json"]), { version: "9.9.9" });
  const hooks = JSON.parse(files["hooks/hooks.json"]).hooks;
  assert.deepEqual(Object.keys(hooks), ["SessionStart"]);
  const command = hooks.SessionStart[0].hooks[0].command;
  assert.match(command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/session-start\.json/);
  // Static: it never calls the engine, which a sandboxed chat hook cannot reach.
  assert.doesNotMatch(command, /ocean|node/);
  assert.deepEqual(JSON.parse(files["hooks/session-start.json"]), {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: MEMORY_AUTHORITY_LINE,
    },
  });
});

test("the default version follows the hook's content, not the engine release", () => {
  const version = JSON.parse(
    desktopPluginFiles()[".claude-plugin/plugin.json"],
  ).version;
  assert.match(version, /^1\.0\.0-[0-9a-f]{12}$/);
  assert.equal(
    JSON.parse(desktopPluginFiles()["version.json"]).version,
    version,
  );
});

test("Desktop's organization plugins folder per platform; Linux has none", () => {
  const saved = process.env.OCEAN_DESKTOP_ORG_PLUGINS;
  delete process.env.OCEAN_DESKTOP_ORG_PLUGINS;
  try {
    assert.equal(
      desktopOrgPluginsDir("darwin"),
      "/Library/Application Support/Claude/org-plugins",
    );
    assert.equal(
      desktopOrgPluginsDir("win32"),
      "C:\\Program Files\\Claude\\org-plugins",
    );
    assert.equal(desktopOrgPluginsDir("linux"), undefined);
    process.env.OCEAN_DESKTOP_ORG_PLUGINS = "/elsewhere";
    assert.equal(desktopOrgPluginsDir("linux"), "/elsewhere");
  } finally {
    if (saved === undefined) delete process.env.OCEAN_DESKTOP_ORG_PLUGINS;
    else process.env.OCEAN_DESKTOP_ORG_PLUGINS = saved;
  }
});

test("install writes the plugin where Desktop reads it, and a second run changes nothing", async (t) => {
  const dir = await temp();
  const orgDir = path.join(dir, "org-plugins");
  const staging = path.join(dir, "staging");
  assert.equal(desktopPluginInstalled(orgDir), false);
  const first = await installDesktopPlugin({ orgDir, staging });
  assert.equal(first.status, "installed");
  assert.equal(first.dir, path.join(orgDir, DESKTOP_PLUGIN_NAME));
  assert.match(first.next, /nothing to upload/);
  assert.equal(desktopPluginInstalled(orgDir), true);
  const second = await installDesktopPlugin({
    orgDir,
    staging,
    copy: () => assert.fail("a current plugin is not copied again"),
  });
  assert.equal(second.status, "current");

  // A changed file is replaced, not left stale.
  await writeFile(
    path.join(first.dir, "hooks", "session-start.json"),
    "stale\n",
  );
  assert.equal(desktopPluginInstalled(orgDir), false);
  assert.equal(
    (await installDesktopPlugin({ orgDir, staging })).status,
    "installed",
  );

  if (process.platform === "win32") {
    t.skip("the hook command is a POSIX shell line");
    return;
  }
  const command = JSON.parse(desktopPluginFiles()["hooks/hooks.json"]).hooks
    .SessionStart[0].hooks[0].command;
  const run = spawnSync("sh", ["-c", command], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: first.dir },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(
    JSON.parse(run.stdout).hookSpecificOutput.additionalContext,
    MEMORY_AUTHORITY_LINE,
  );
});

test("an admin-only folder goes through the elevated copy", async () => {
  const dir = await temp();
  const orgDir = path.join(dir, "org-plugins");
  const calls = [];
  const result = await installDesktopPlugin({
    orgDir,
    staging: path.join(dir, "staging"),
    copy: async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    },
    // Blocks like the real one, which returns once the password prompt is answered.
    elevate: (staging, target) => {
      calls.push([staging, target]);
      mkdirSync(orgDir, { recursive: true });
      cpSync(staging, target, { recursive: true });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], path.join(orgDir, DESKTOP_PLUGIN_NAME));
  assert.equal(result.status, "installed");
  assert.equal(desktopPluginInstalled(orgDir), true);
});

test("a declined prompt, or no folder on this platform, falls back to a zip to upload", async () => {
  const dir = await temp();
  const declined = await installDesktopPlugin({
    orgDir: path.join(dir, "org-plugins"),
    staging: path.join(dir, "staging"),
    copy: async () => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    },
    elevate: () => {
      throw new Error("User canceled.");
    },
  });
  assert.equal(declined.status, "manual");
  assert.match(declined.reason, /declined/);
  assert.match(declined.next, /Upload plugin/);
  const none = await installDesktopPlugin({ orgDir: undefined });
  assert.equal(none.status, "manual");
  assert.match(none.reason, /no organization plugins folder/);
  const zip = await readFile(none.file);
  assert.deepEqual(zip, zipStored(desktopPluginFiles()));
});

test("the zip is deterministic", () => {
  const files = desktopPluginFiles("9.9.9");
  assert.deepEqual(zipStored(files), zipStored(files));
});
