import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_PLUGIN_FILE,
  claudePlugin,
  claudePluginManifest,
  DESKTOP_EXTENSION_FILE,
  desktopConfigHasOcean,
  desktopExtension,
  desktopExtensionManifest,
  oceanIcon,
  writeBundles,
} from "../dist/application/clients/bundles.js";

const harness = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const coreSkill = () =>
  readFileSync(
    path.join(harness, "skills", "core", "ocean-memory", "SKILL.md"),
    "utf8",
  ).replace(/\r\n/g, "\n");

const tmp = () => mkdtemp(path.join(os.tmpdir(), "ocean-bundles-"));

async function unzip(buffer) {
  const dir = await tmp();
  const zip = path.join(dir, "bundle.zip");
  await writeFile(zip, buffer);
  const out = path.join(dir, "out");
  execFileSync("unzip", ["-q", zip, "-d", out]);
  return out;
}

const entry = { command: "/opt/ocean/shims/ocean", args: ["mcp", "serve"] };

test("the Desktop Extension manifest has what MCPB 0.3 requires, named Ocean with an icon (T-328)", () => {
  const manifest = desktopExtensionManifest("9.9.9", entry);
  assert.equal(manifest.manifest_version, "0.3");
  assert.equal(manifest.name, "ocean");
  assert.equal(manifest.display_name, "Ocean");
  assert.equal(manifest.version, "9.9.9");
  assert.ok(manifest.description);
  assert.ok(manifest.author.name);
  assert.equal(manifest.icon, "icon.png");
  assert.equal(manifest.server.type, "node");
  assert.equal(manifest.server.entry_point, "server/index.js");
  assert.deepEqual(manifest.server.mcp_config.args, [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MCPB placeholder
    "${__dirname}/server/index.js",
  ]);
  assert.deepEqual(manifest.server.mcp_config.env, {
    OCEAN_MCPB_COMMAND: entry.command,
    OCEAN_MCPB_ARGS: '["mcp","serve"]',
  });
});

test("Ocean.mcpb holds the manifest, a 512px PNG icon and the launcher", async () => {
  const out = await unzip(desktopExtension("9.9.9", entry));
  const manifest = JSON.parse(
    await readFile(path.join(out, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.display_name, "Ocean");
  const icon = await readFile(path.join(out, manifest.icon));
  assert.deepEqual(
    [...icon.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  );
  assert.equal(icon.readUInt32BE(16), 512);
  assert.equal(icon.readUInt32BE(20), 512);
  assert.match(
    await readFile(path.join(out, manifest.server.entry_point), "utf8"),
    /OCEAN_MCPB_COMMAND/,
  );
});

test("the launcher runs the baked command with stdio and passes its exit code on", async () => {
  const out = await unzip(desktopExtension("9.9.9", entry));
  const launcher = path.join(out, "server", "index.js");
  const run = (env, input) =>
    spawnSync(process.execPath, [launcher], {
      env: { ...process.env, ...env },
      input,
      encoding: "utf8",
    });
  const echoed = run(
    {
      OCEAN_MCPB_COMMAND: process.execPath,
      OCEAN_MCPB_ARGS: JSON.stringify([
        "-e",
        "process.stdin.pipe(process.stdout);process.stdin.on('end',()=>process.exit(process.env.OCEAN_MCPB_COMMAND?9:3))",
      ]),
    },
    "ping",
  );
  assert.equal(echoed.stdout, "ping");
  assert.equal(
    echoed.status,
    3,
    "the launcher's own variables do not reach Ocean",
  );
  const missing = run({ OCEAN_MCPB_COMMAND: path.join(out, "no-ocean") }, "");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ocean setup/);
});

test("ocean.plugin is a Claude plugin named ocean carrying the core ocean-memory skill", async () => {
  const out = await unzip(claudePlugin("9.9.9"));
  const manifest = JSON.parse(
    await readFile(path.join(out, ".claude-plugin", "plugin.json"), "utf8"),
  );
  assert.equal(manifest.name, "ocean");
  assert.equal(manifest.version, "9.9.9");
  assert.equal(
    (
      await readFile(
        path.join(out, "skills", "ocean-memory", "SKILL.md"),
        "utf8",
      )
    ).replace(/\r\n/g, "\n"),
    coreSkill(),
  );
  // No connector and no hook: chat, Cowork and Claude Code already reach Ocean, and a second
  // server would show every tool twice.
  assert.throws(() => readFileSync(path.join(out, ".mcp.json")));
  assert.throws(() => readFileSync(path.join(out, "hooks", "hooks.json")));
});

test("writeBundles saves both files where asked", async () => {
  const dir = path.join(await tmp(), "Downloads");
  const written = await writeBundles("9.9.9", dir);
  assert.equal(written.extension, path.join(dir, DESKTOP_EXTENSION_FILE));
  assert.equal(written.plugin, path.join(dir, CLAUDE_PLUGIN_FILE));
  assert.ok((await readFile(written.extension)).length > 0);
  assert.ok((await readFile(written.plugin)).length > 0);
});

test("an Ocean entry in Claude Desktop's config is reported, so the extension is not a second copy", async () => {
  const home = await tmp();
  assert.equal(desktopConfigHasOcean(home, "darwin"), false);
  const dir = path.join(home, "Library", "Application Support", "Claude");
  await mkdir(dir, { recursive: true });
  const config = path.join(dir, "claude_desktop_config.json");
  await writeFile(config, JSON.stringify({ mcpServers: { other: {} } }));
  assert.equal(desktopConfigHasOcean(home, "darwin"), false);
  await writeFile(config, JSON.stringify({ mcpServers: { ocean: {} } }));
  assert.equal(desktopConfigHasOcean(home, "darwin"), true);
  await writeFile(config, "{ not json");
  assert.equal(desktopConfigHasOcean(home, "darwin"), false);
});

test("the icon is drawn at any size", () => {
  const icon = oceanIcon(64);
  assert.equal(icon.readUInt32BE(16), 64);
});

test("the repository's marketplace serves kernel/plugins/ocean, kept equal to the plugin bundle", async () => {
  const repo = path.resolve(harness, "..", "..", "..");
  const marketplace = JSON.parse(
    await readFile(
      path.join(repo, ".claude-plugin", "marketplace.json"),
      "utf8",
    ),
  );
  assert.equal(marketplace.name, "ocean");
  const [entry] = marketplace.plugins;
  assert.equal(entry.name, "ocean");
  assert.equal(entry.source, "./kernel/plugins/ocean");
  const plugin = path.join(repo, entry.source);
  const manifest = JSON.parse(
    await readFile(path.join(plugin, ".claude-plugin", "plugin.json"), "utf8"),
  );
  // No version: Claude versions a marketplace plugin by commit, so every skill change syncs.
  const { version, ...expected } = claudePluginManifest("9.9.9");
  assert.equal(version, "9.9.9");
  assert.deepEqual(
    manifest,
    expected,
    "run node scripts/generate-claude-plugin.mjs",
  );
  assert.equal(
    await readFile(
      path.join(plugin, "skills", "ocean-memory", "SKILL.md"),
      "utf8",
    ),
    coreSkill(),
    "run node scripts/generate-claude-plugin.mjs",
  );
  // claude.ai rejects a plugin with a top-level bin/ directory.
  assert.throws(() => readFileSync(path.join(plugin, "bin")));
});
