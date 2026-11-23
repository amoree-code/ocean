import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MEMORY_AUTHORITY_LINE } from "@ocean/core/domain/mcp/memory-contract.js";
import {
  DESKTOP_PLUGIN_NAME,
  desktopPluginFiles,
  writeDesktopPlugin,
  zipStored,
} from "../dist/application/clients/desktop-plugin.js";

test("the Desktop plugin is hook-only and its start message is the shared authority line", () => {
  const files = desktopPluginFiles("9.9.9");
  assert.deepEqual(Object.keys(files).sort(), [
    ".claude-plugin/plugin.json",
    "hooks/hooks.json",
    "hooks/session-start.json",
  ]);
  const manifest = JSON.parse(files[".claude-plugin/plugin.json"]);
  assert.equal(manifest.name, DESKTOP_PLUGIN_NAME);
  assert.equal(manifest.version, "9.9.9");
  const hooks = JSON.parse(files["hooks/hooks.json"]).hooks;
  assert.deepEqual(Object.keys(hooks), ["SessionStart"]);
  const command = hooks.SessionStart[0].hooks[0].command;
  assert.match(command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/session-start\.json/);
  // Static: it never calls the engine, which a sandboxed chat hook cannot reach.
  assert.doesNotMatch(command, /ocean|node/);
  const start = JSON.parse(files["hooks/session-start.json"]);
  assert.deepEqual(start, {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: MEMORY_AUTHORITY_LINE,
    },
  });
});

test("the zip is deterministic, and the hook command run from it prints the start JSON", async (t) => {
  const files = desktopPluginFiles("9.9.9");
  assert.deepEqual(zipStored(files), zipStored(files));
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-desktop-plugin-"));
  const zip = path.join(dir, "nested", "plugin.zip");
  const result = await writeDesktopPlugin(zip);
  assert.equal(result.file, zip);
  assert.match(result.next, /Upload plugin/);
  if (spawnSync("unzip", ["-v"]).status !== 0) {
    t.skip("no unzip on this machine");
    return;
  }
  const root = path.join(dir, "out");
  const unzip = spawnSync("unzip", ["-q", zip, "-d", root], {
    encoding: "utf8",
  });
  assert.equal(unzip.status, 0, unzip.stderr);
  const written = desktopPluginFiles();
  for (const [name, text] of Object.entries(written))
    assert.equal(await readFile(path.join(root, name), "utf8"), text);
  const command = JSON.parse(written["hooks/hooks.json"]).hooks.SessionStart[0]
    .hooks[0].command;
  const run = spawnSync("sh", ["-c", command], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(
    JSON.parse(run.stdout).hookSpecificOutput.additionalContext,
    MEMORY_AUTHORITY_LINE,
  );
});
