#!/usr/bin/env node
// Generates ocean-marketplace.json at the engine root — the engine's own marketplace index — from the core
// skills and the MCP capability files, with each payload's content digest, so the index can never
// drift from the files it pins. `--check` fails instead of writing when it is out of date.
//
// It runs before the build (CI's check:skills step), so it uses only Node built-ins. The digest
// below must stay byte-for-byte the algorithm of `contentDigest` in
// packages/market/src/capability/content-digest.ts; marketplace-engine.test.mjs recomputes every
// pinned digest with that function and fails if the two ever disagree. The index shape itself is
// validated by `marketplaceIndexSchema` whenever the catalog reads it, and in that test.
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function contentDigest(root) {
  const hash = createHash("sha256");
  const info = await lstat(root);
  if (info.isSymbolicLink()) throw new Error(`${root} is a symlink`);
  if (info.isFile()) {
    const bytes = await readFile(root);
    hash.update(`file\0\0${bytes.length}\0`).update(bytes);
    return hash.digest("hex");
  }
  async function walk(current, prefix) {
    const entries = (await readdir(current, { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const entryInfo = await lstat(full);
      if (entryInfo.isSymbolicLink())
        throw new Error(`${relative} is a symlink inside the payload`);
      if (entryInfo.isDirectory()) {
        hash.update(`dir\0${relative}\0`);
        await walk(full, relative);
      } else if (entryInfo.isFile()) {
        const bytes = await readFile(full);
        hash.update(`file\0${relative}\0${bytes.length}\0`).update(bytes);
      } else throw new Error(`${relative} is not a regular file`);
    }
  }
  await walk(root, "");
  return hash.digest("hex");
}

const checkOnly = process.argv.includes("--check");
const engine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
