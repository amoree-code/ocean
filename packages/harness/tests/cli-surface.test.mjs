import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { commandRegistry } from "../dist/interfaces/cli/command-registry.js";
import {
  commandHelp,
  renderHelp,
  wantsCommandHelp,
} from "../dist/interfaces/cli/help-command.js";

const cli = path.resolve("dist/main.js");

test("CLI version comes from package.json", async () => {
  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  const result = spawnSync(process.execPath, [cli, "--version"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), version);
});

test("CLI help exposes every top-level command", () => {
  const result = spawnSync(process.execPath, [cli, "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  for (const command of [
    "setup",
    "context",
    "project",
    "tasks",
    "policy",
    "lifecycle",
    "doctor",
    "repair",
    "run",
    "profiles",
    "session",
    "service",
    "intercept",
    "operate",
    "gateway",
    "schedule",
    "client",
    "clients",
    "install",
    "update",
    "remove",
    "auth",
    "mcp",
    "browser",
    "memory",
    "pull",
    "observe",
    "capture",
    "handoff",
    "idea",
    "daily",
    "skill",
    "catalog",
    "obsidian",
    "hook",
    "migrate",
    "env",
  ])
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`), command);
});

test("every registered command is in the top-level help and has its own help entry", () => {
  const help = renderHelp();
  for (const command of Object.keys(commandRegistry)) {
    assert.match(help, new RegExp(`\\b${command}\\b`), command);
    assert.ok(commandHelp[command], `commandHelp is missing ${command}`);
    assert.match(commandHelp[command][1], new RegExp(`^ocean ${command}\\b`));
  }
  assert.deepEqual(
    Object.keys(commandHelp).filter((command) => !commandRegistry[command]),
    [],
  );
});

test("<command> --help prints that command's usage and runs nothing", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocean-help-home-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-help-root-"));
  const run = promisify(execFile);
  await Promise.all(
    Object.keys(commandRegistry).map(async (command) => {
      const { stdout, stderr } = await run(
        process.execPath,
        [cli, command, "--help"],
        { env: { ...process.env, HOME: home, OCEAN_ROOT: root } },
      );
      assert.match(stdout, new RegExp(`^Usage: ocean ${command}\\b`), command);
      assert.doesNotMatch(stderr, /ExperimentalWarning/, command);
    }),
  );
  assert.deepEqual(await readdir(home), []);
  assert.deepEqual(await readdir(root), []);
});

test("a help flag meant for a wrapped program is passed through, not taken as Ocean's", () => {
  assert.equal(wantsCommandHelp("tasks", ["list", "--help"]), true);
  assert.equal(wantsCommandHelp("memory", ["search", "-h"]), true);
  assert.equal(wantsCommandHelp("tasks", ["list", "--", "--help"]), false);
  assert.equal(wantsCommandHelp("intercept", ["--help"]), true);
  assert.equal(
    wantsCommandHelp("intercept", ["--client", "claude", "--", "--help"]),
    false,
  );
  assert.equal(wantsCommandHelp("client", ["open", "claude", "--help"]), false);
  assert.equal(
    wantsCommandHelp("operate", ["what", "does", "-h", "do"]),
    false,
  );
});

test("an inherited object key is an unknown command, not a handler", () => {
  const result = spawnSync(process.execPath, [cli, "toString"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: toString/);
});

test("the README command map has a row for every registered command", async () => {
  const readme = await readFile("../../README.md", "utf8");
  const map = readme.slice(
    readme.indexOf("## Commands"),
    readme.indexOf("\n## ", readme.indexOf("## Commands") + 1),
  );
  const rows = map.split("\n").filter((line) => line.startsWith("| `ocean "));
  for (const command of Object.keys(commandRegistry))
    assert.ok(
      rows.some((row) =>
        new RegExp(`^\\| \`ocean ${command}\`|/ \`${command}\``).test(row),
      ),
      `README command map is missing ${command}`,
    );
});
