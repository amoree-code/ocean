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

// How a path reads inside JSON text: on Windows every backslash is escaped.
const inJson = (value) => JSON.stringify(value).slice(1, -1);

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
        gemini.replaceAll(inJson(stale), inJson(entry)),
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

test("an entry into the removed release build is repointed to the checkout, even while it exists", async () => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "ocean-entry-release-"),
  );
  // T-294's release build, which T-306 removed: clients and the service still launch it.
  const release = path.join(
    workspace,
    "bridge",
    "runtime",
    "release",
    "current",
    "packages",
    "harness",
    "dist",
    "main.js",
  );
  await mkdir(path.dirname(release), { recursive: true });
  await writeFile(release, "// built\n");
  const saved = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = workspace;
  try {
    const gemini = JSON.stringify({
      mcpServers: { ocean: { args: [release, "obsidian", "mcp"] } },
    });
    await withHome({ ".gemini/settings.json": gemini }, async (home, read) => {
      const result = byFile(await repairEngineEntries(home))[
        "~/.gemini/settings.json"
      ];
      assert.equal(result.status, "updated");
      assert.deepEqual(result.replaced, [release]);
      assert.equal(
        await read(".gemini/settings.json"),
        gemini.replaceAll(inJson(release), inJson(entry)),
      );
    });
    const plistFile = "Library/LaunchAgents/com.ocean.runtime.plist";
    const plist = `<plist><dict><key>ProgramArguments</key><array><string>/usr/bin/node</string><string>${release}</string><string>service</string></array></dict></plist>\n`;
    await withHome({ [plistFile]: plist }, async (home, read) => {
      const result = byFile(await repairEngineEntries(home))[`~/${plistFile}`];
      assert.equal(result.kind, "service");
      assert.equal(result.status, "updated");
      assert.equal(await read(plistFile), plist.replaceAll(release, entry));
      const again = byFile(await repairEngineEntries(home))[`~/${plistFile}`];
      assert.equal(again.status, "current");
    });
  } finally {
    if (saved === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = saved;
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Antigravity's and Claude Desktop's MCP entries are repaired like the other clients'", async () => {
  const config = JSON.stringify({
    mcpServers: { ocean: { command: "node", args: [stale, "mcp", "serve"] } },
  });
  const antigravity = ".gemini/antigravity/mcp_config.json";
  const desktop =
    "Library/Application Support/Claude/claude_desktop_config.json";
  await withHome(
    { [antigravity]: config, [desktop]: config },
    async (home, read) => {
      const results = byFile(await repairEngineEntries(home));
      for (const file of [antigravity, desktop]) {
        assert.equal(results[`~/${file}`].status, "updated");
        assert.equal(
          await read(file),
          config.replaceAll(inJson(stale), inJson(entry)),
        );
      }
    },
  );
});

test("a version-managed node launches the ocean MCP entry through the shim (T-307)", async () => {
  const { isVersionedNode, oceanServerEntry } = await import(
    "../dist/application/clients/clients.js"
  );
  for (const node of [
    "/opt/u/.local/share/fnm/node-versions/v22.1.0/installation/bin/node",
    "/opt/u/.nvm/versions/node/v22.1.0/bin/node",
    "/opt/u/.volta/tools/image/node/22.1.0/bin/node",
  ])
    assert.equal(isVersionedNode(node), true, node);
  assert.equal(isVersionedNode("/opt/homebrew/bin/node"), false);
  const engine = "/srv/ocean/kernel/packages/harness/dist/main.js";
  const fnm =
    "/opt/u/.local/share/fnm/node-versions/v22.1.0/installation/bin/node";
  const shim = oceanServerEntry(fnm, engine, "darwin");
  assert.deepEqual(shim.args, ["mcp", "serve"]);
  assert.match(shim.command, /bridge[\\/]runtime[\\/]shims[\\/]ocean$/);
  assert.deepEqual(
    oceanServerEntry("/opt/homebrew/bin/node", engine, "darwin"),
    {
      command: "/opt/homebrew/bin/node",
      args: [engine, "mcp", "serve"],
    },
  );
  // Windows and a temporary engine keep the direct form.
  assert.equal(oceanServerEntry(fnm, engine, "win32").command, fnm);
  assert.equal(
    oceanServerEntry(fnm, path.join(os.tmpdir(), "wt", "main.js"), "darwin")
      .command,
    fnm,
  );
});
