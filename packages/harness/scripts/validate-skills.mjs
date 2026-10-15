#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "skills");
const catalog = JSON.parse(
  await readFile(path.join(root, "index.json"), "utf8"),
);
const entries = new Map(catalog.map((item) => [item.name, item]));
const errors = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target);
    else if (entry.name === "SKILL.md") await validate(target);
  }
}

async function validate(file) {
  const relative = path.relative(root, file).split(path.sep);
  const name = relative.at(-2);
  const source = await readFile(file, "utf8");
  if (!source.startsWith("---"))
    return errors.push(`${file}: missing frontmatter`);
  const end = source.indexOf("\n---", 4);
  if (end < 0) return errors.push(`${file}: unterminated frontmatter`);
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
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.name ?? ""))
    errors.push(`${file}: invalid name`);
  if (fields.name !== name)
    errors.push(`${file}: frontmatter name must match directory (${name})`);
  if (!fields.description) errors.push(`${file}: missing description`);
  const metadata = entries.get(name);
  if (!metadata) errors.push(`${file}: missing catalog entry`);
  else if (metadata.description !== fields.description)
    errors.push(`${file}: description differs from catalog`);
}

await walk(root);
const skillFiles = (await readdir(root, { recursive: true }))
  .map((file) => file.split(path.sep).join("/"))
  .filter((file) => file.endsWith("/SKILL.md") || file === "SKILL.md");
for (const name of entries.keys())
  if (!skillFiles.some((file) => file.split("/").at(-2) === name))
    errors.push(`index.json: missing skill file for ${name}`);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`Validated ${skillFiles.length} Agent Skills`);
