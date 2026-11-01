import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

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
