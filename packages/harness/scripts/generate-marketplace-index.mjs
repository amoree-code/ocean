#!/usr/bin/env node
// Generates ocean-marketplace.json at the engine root — the engine's own marketplace index — from the core
// skills and the MCP capability files, with each payload's content digest, so the index can never
// drift from the files it pins. `--check` fails instead of writing when it is out of date.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { marketplaceIndexSchema } from "@ocean/core/domain/capabilities/capability-manifest.js";
import { contentDigest } from "@ocean/market/capability/content-digest.js";

const checkOnly = process.argv.includes("--check");
const engine = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const marketDir = path.join(engine, "market");
const indexPath = path.join(engine, "ocean-marketplace.json");
const { version } = JSON.parse(
  await readFile(path.join(engine, "package.json"), "utf8"),
);
const engines = { ocean: `>=${version}` };

const directories = async (root) =>
  (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

const capabilities = [];
for (const name of await directories(path.join(engine, "skills", "core"))) {
  capabilities.push({
    kind: "skill",
    name: `dev.ocean.skills.${name}`,
    version,
    engines,
    source: { type: "path", path: `skills/core/${name}` },
    integrity: {
      sha256: await contentDigest(path.join(engine, "skills", "core", name)),
    },
    spec: { directory: name },
  });
}
for (const name of await directories(path.join(marketDir, "mcp"))) {
  const folder = path.join(marketDir, "mcp", name);
  const { server, ...envelope } = JSON.parse(
    await readFile(path.join(folder, "ocean.capability.json"), "utf8"),
  );
  capabilities.push({
    ...envelope,
    version,
    engines,
    source: { type: "path", path: `market/mcp/${name}` },
    integrity: { sha256: await contentDigest(folder) },
    spec: server,
  });
}

// Sources are relative to the engine root, where this index is read from.
const index = {
  schemaVersion: 1,
  name: "ocean-engine",
  capabilities,
};
marketplaceIndexSchema.parse(index);
const rendered = `${JSON.stringify(index, null, 2)}\n`;

if (checkOnly) {
  let current = "";
  try {
    current = await readFile(indexPath, "utf8");
  } catch {}
  if (current !== rendered) {
    console.error(
      "ocean-marketplace.json is out of date; run: node scripts/generate-marketplace-index.mjs",
    );
    process.exit(1);
  }
  console.log(
    `marketplace index current (${index.capabilities.length} capabilities)`,
  );
} else {
  await writeFile(indexPath, rendered);
  console.log(`wrote ${indexPath} (${index.capabilities.length} capabilities)`);
}
