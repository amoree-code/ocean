import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  enginePath,
  engineRoot,
  registerEngineRoot,
  repoRoot,
} from "@ocean/core/shared/paths.js";
import { repairEngineEntries } from "../dist/application/integrations/engine-entry-repair.js";

const entry = enginePath("dist", "main.js");
// The engine's entry before it moved to packages/harness (T-293).
const stale = path.join(repoRoot(), "packages", "core", "dist", "main.js");

async function withHome(files, run) {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocean-entry-repair-"));
  try {
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(home, file)), { recursive: true });
      await writeFile(path.join(home, file), text);
    }
    await run(home, (file) => readFile(path.join(home, file), "utf8"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const byFile = (results) =>
  Object.fromEntries(results.map((result) => [result.file, result]));

test("a client's MCP entry that points at a moved engine file is repointed, nothing else changes", async () => {
  const gemini = JSON.stringify(
    {
      theme: "dark",
      mcpServers: {
        ocean: { command: "/usr/bin/node", args: [stale, "obsidian", "mcp"] },
        other: { command: "/usr/bin/node", args: ["/elsewhere/dist/main.js"] },
      },
    },
    null,
    2,
  );
  const hermes = `model:\n  default: x\nmcp_servers:\n  ocean:\n    command: /usr/bin/node\n    args:\n      - ${stale}\n      - obsidian\n      - mcp\n`;
  await withHome(
    { ".gemini/settings.json": gemini, ".hermes/config.yaml": hermes },
    async (home, read) => {
      const first = byFile(await repairEngineEntries(home));
      assert.equal(first["~/.gemini/settings.json"].status, "updated");
      assert.deepEqual(first["~/.hermes/config.yaml"].replaced, [stale]);
      assert.equal(first["~/.codex/config.toml"].status, "missing");
      assert.equal(
        await read(".gemini/settings.json"),
        gemini.replaceAll(stale, entry),
      );
      assert.equal(
        await read(".hermes/config.yaml"),
        hermes.replaceAll(stale, entry),
      );
      assert.match(
        await read(".gemini/settings.json"),
        /\/elsewhere\/dist\/main\.js/,
      );
      const second = byFile(await repairEngineEntries(home));
      assert.equal(second["~/.gemini/settings.json"].status, "current");
      assert.equal(second["~/.hermes/config.yaml"].status, "current");
    },
  );
});

test("an entry that already points at an existing engine file is left alone", async () => {
  const claude = JSON.stringify({ mcpServers: { ocean: { args: [entry] } } });
  await withHome({ ".claude.json": claude }, async (home, read) => {
    assert.equal(
      byFile(await repairEngineEntries(home))["~/.claude.json"].status,
      "current",
    );
    assert.equal(await read(".claude.json"), claude);
  });
});

test("another kernel package's unbuilt server and an unreadable config are not misreported or touched", async () => {
  const other = path.join(
    repoRoot(),
    "packages",
    "market",
    "dist",
    "not-built.js",
  );
  const unbuilt = path.join(repoRoot(), "packages", "lab", "dist", "main.js");
  const cursor = JSON.stringify({
    mcpServers: { lab: { args: [unbuilt, other] } },
  });
  await withHome({ ".cursor/mcp.json": cursor }, async (home, read) => {
    await mkdir(path.join(home, ".codex", "config.toml"), { recursive: true });
    const results = byFile(await repairEngineEntries(home));
    assert.equal(results["~/.cursor/mcp.json"].status, "current");
    assert.equal(await read(".cursor/mcp.json"), cursor);
    assert.equal(results["~/.codex/config.toml"].status, "unreadable");
  });
});

test("run from a release, the checkout's existing engine entry is repointed to current", async () => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "ocean-entry-release-"),
  );
  const releases = path.join(workspace, "bridge", "runtime", "release");
  const release = path.join(releases, "abc123", "packages", "harness");
  const checkoutEntry = path.join(
    workspace,
    "kernel",
    "packages",
    "harness",
    "dist",
    "main.js",
  );
  const current = path.join(
    releases,
    "current",
    "packages",
    "harness",
    "dist",
    "main.js",
  );
  for (const file of [checkoutEntry, path.join(release, "dist", "main.js")]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "// built\n");
  }
  await symlink("abc123", path.join(releases, "current"));
  const original = engineRoot();
  const saved = process.env.OCEAN_ROOT;
  delete process.env.OCEAN_ROOT;
  registerEngineRoot(release);
  try {
    const gemini = JSON.stringify({
      mcpServers: { ocean: { args: [checkoutEntry, "obsidian", "mcp"] } },
    });
    await withHome({ ".gemini/settings.json": gemini }, async (home, read) => {
      const result = byFile(await repairEngineEntries(home))[
        "~/.gemini/settings.json"
      ];
      assert.equal(result.status, "updated");
      assert.deepEqual(result.replaced, [checkoutEntry]);
      assert.equal(
        await read(".gemini/settings.json"),
        gemini.replaceAll(checkoutEntry, current),
      );
    });
  } finally {
    registerEngineRoot(original);
    if (saved !== undefined) process.env.OCEAN_ROOT = saved;
    await rm(workspace, { recursive: true, force: true });
  }
});
