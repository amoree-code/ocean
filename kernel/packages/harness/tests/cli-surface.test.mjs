import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
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

test("a help flag before `--` is Ocean's; after `--` it belongs to the wrapped program", () => {
  assert.equal(wantsCommandHelp(["list", "--help"]), true);
  assert.equal(wantsCommandHelp(["search", "-h"]), true);
  assert.equal(wantsCommandHelp(["list", "--", "--help"]), false);
  assert.equal(wantsCommandHelp(["--help"]), true);
  // T-308 R2: a help flag after a subcommand or its arguments used to run the command.
  assert.equal(wantsCommandHelp(["sync", "--help"]), true);
  assert.equal(wantsCommandHelp(["register", "x", "-h"]), true);
  assert.equal(wantsCommandHelp(["--client", "claude", "--help"]), true);
  assert.equal(wantsCommandHelp(["open", "claude", "--help"]), true);
  assert.equal(wantsCommandHelp(["what", "does", "-h", "do"]), true);
  assert.equal(wantsCommandHelp(["--client", "claude", "--", "--help"]), false);
  assert.equal(wantsCommandHelp(["open", "claude", "--", "-h"]), false);
  assert.equal(wantsCommandHelp(["--", "what", "does", "-h", "do"]), false);
});

// Every program a passthrough command could start, recorded instead of run: a help regression
// then shows up as a log line, never as a real launchd/systemd change or a launched client.
async function stubbedPath() {
  const bin = await mkdtemp(path.join(os.tmpdir(), "ocean-help-bin-"));
  const log = path.join(bin, "calls.log");
  for (const name of [
    "launchctl",
    "systemctl",
    "claude",
    "codex",
    "gemini",
    "code",
    "ls",
  ]) {
    const file = path.join(bin, name);
    await writeFile(file, `#!/bin/sh\necho "${name} $*" >> "${log}"\n`);
    await chmod(file, 0o755);
  }
  return { bin, log };
}

test("help after subcommand arguments prints usage and changes no files, clients or services", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocean-help-home-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-help-root-"));
  const { bin, log } = await stubbedPath();
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OCEAN_ROOT: root,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };
  const run = promisify(execFile);
  for (const argv of [
    ["client", "sync", "--help"],
    ["client", "sync", "-h"],
    ["client", "register", "foo", "--help"],
    ["client", "enable", "claude", "-h"],
    ["client", "disable", "claude", "--help"],
    ["client", "vscode-wrapper", "--apply", "--help"],
    ["client", "manage", "--help"],
    ["client", "open", "claude", "--help"],
    ["intercept", "--client", "claude", "--help"],
    ["intercept", "--client", "claude", "--executable", "/bin/echo", "-h"],
    ["observe", "ls", "-h"],
    ["observe", "show", "abc", "--help"],
    ["operate", "what", "does", "-h", "do"],
  ]) {
    const { stdout } = await run(process.execPath, [cli, ...argv], { env });
    assert.match(
      stdout,
      new RegExp(`^Usage: ocean ${argv[0]}\\b`),
      argv.join(" "),
    );
  }
  assert.deepEqual(await readdir(home), []);
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(
    (await readdir(bin)).filter((file) => file === "calls.log"),
    [],
    existsSync(log) ? await readFile(log, "utf8") : "",
  );
});

test("after `--`, a help flag reaches the wrapped client", {
  skip: process.platform === "win32" && "POSIX stub",
}, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocean-help-home-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-help-root-"));
  const { bin, log } = await stubbedPath();
  // An authenticated claude, so `client open` gets past its login check.
  await writeFile(
    path.join(bin, "claude"),
    `#!/bin/sh\necho "claude $*" >> "${log}"\n[ "$1" = auth ] && echo '{"loggedIn": true}'\nexit 0\n`,
  );
  await promisify(execFile)(
    process.execPath,
    [cli, "client", "open", "claude", "--task", "T-1", "--", "--help", "-x"],
    {
      env: {
        ...process.env,
        HOME: home,
        OCEAN_ROOT: root,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      },
    },
  );
  const calls = (await readFile(log, "utf8")).trim().split("\n");
  assert.equal(calls.at(-1), "claude --help -x");
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
