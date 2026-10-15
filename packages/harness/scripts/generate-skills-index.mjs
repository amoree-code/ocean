#!/usr/bin/env node
// Generates skills/index.json from each SKILL.md's frontmatter so the
// catalog can never drift from the skill files themselves.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const checkOnly = process.argv.includes("--check");
const root = path.resolve(
  process.argv.find((arg, i) => i >= 2 && !arg.startsWith("--")) ?? "skills",
);
const indexPath = path.join(root, "index.json");

function parseFrontmatter(source, file) {
  if (!source.startsWith("---"))
    throw new Error(`${file}: missing frontmatter`);
  const end = source.indexOf("\n---", 4);
  if (end < 0) throw new Error(`${file}: unterminated frontmatter`);
  const fields = {};
  let currentKey = null;
  for (const line of source.slice(4, end).split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^\s/.test(line) && currentKey) {
      // Continuation of a folded multi-line scalar (e.g. a wrapped description).
      fields[currentKey] += ` ${line.trim()}`;
      continue;
    }
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    currentKey = line.slice(0, separator).trim();
    fields[currentKey] = line.slice(separator + 1).trim();
  }
  return fields;
}

async function collect(directory) {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) entries.push(...(await collect(target)));
    else if (entry.name === "SKILL.md") {
      const fields = parseFrontmatter(await readFile(target, "utf8"), target);
      entries.push({
        name: fields.name,
        description: fields.description,
        version: fields.version ?? "1.0.0",
        category: fields.category ?? "core",
      });
    }
  }
  return entries;
}

const catalog = (await collect(root)).sort((a, b) =>
  a.name.localeCompare(b.name),
);
const rendered = `${JSON.stringify(catalog, null, 2)}\n`;

if (checkOnly) {
  const current = await readFile(indexPath, "utf8").catch(() => null);
  if (current?.replace(/\r\n/g, "\n") !== rendered) {
    console.error(
      `${indexPath} is out of date. Run: node scripts/generate-skills-index.mjs ${root}`,
    );
    process.exit(1);
  }
  console.log(`${indexPath} matches SKILL.md frontmatter.`);
} else {
  await writeFile(indexPath, rendered);
  console.log(`Wrote ${indexPath} (${catalog.length} skills).`);
}
