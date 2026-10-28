import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { enginePath, repoRoot } from "@ocean/core/shared/paths.js";
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
