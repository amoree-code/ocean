#!/usr/bin/env node
// Generates kernel/plugins/ocean/, the Claude plugin that the repository's marketplace
// (.claude-plugin/marketplace.json at the repo root) serves: plugin.json plus a copy of the core
// `ocean-memory` skill. On claude.ai, Customize → Plugins → Add marketplace with this repository
// saves the plugin to the account (chat, Cowork, Claude Code), and Sync automatically pulls every
// push to main, so the skill stays current with no re-upload (T-328).
//
// plugin.json carries no version on purpose: Claude then versions the plugin by commit, so any
// change to the skill is an update. `--check` fails instead of writing when the folder is stale.
// Built-ins only, like the other generators, since it runs before the build (check:skills).
// bundles.test.mjs checks plugin.json against claudePluginManifest() in bundles.ts.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const harness = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const plugin = path.resolve(harness, "..", "..", "plugins", "ocean");
const skill = path.join(harness, "skills", "core", "ocean-memory", "SKILL.md");
const REPOSITORY = "https://github.com/amoree-code/ocean";

const manifest = {
  name: "ocean",
  description:
    "Your local memory for every AI client: projects, tasks, decisions and preferences, kept on your computer.",
  author: {
    name: "AMEER ABDULKAREEM JABBAR LAMI",
    url: "https://github.com/amoree-code",
  },
  homepage: REPOSITORY,
  repository: REPOSITORY,
  license: "MIT",
  keywords: ["memory", "knowledge", "local-first"],
};

const files = new Map([
  [
    path.join(plugin, ".claude-plugin", "plugin.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  ],
  [
    path.join(plugin, "skills", "ocean-memory", "SKILL.md"),
    (await readFile(skill, "utf8")).replace(/\r\n/g, "\n"),
  ],
]);

const check = process.argv.includes("--check");
const stale = [];
for (const [file, content] of files) {
  const current = await readFile(file, "utf8").catch(() => null);
  if (current === content) continue;
  // Biome may reflow the JSON it formats; the same value is current.
  if (file.endsWith(".json") && current !== null) {
    try {
      if (isDeepStrictEqual(JSON.parse(current), JSON.parse(content))) continue;
    } catch {}
  }
  if (check) stale.push(path.relative(harness, file));
  else {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}
if (stale.length) {
  console.error(
    `Claude plugin is out of date: ${stale.join(", ")}\nRun: node scripts/generate-claude-plugin.mjs`,
  );
  process.exit(1);
}
