#!/usr/bin/env node
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";

const explicitRoot = process.argv[2];
// The workspace project's folder, under the flat layout (04-projects/) or the pre-T-243
// brain/04-projects/.
const defaultRoots = [
  "../04-projects/ocean/tasks",
  "../brain/04-projects/ocean/tasks",
].map((candidate) => path.resolve(candidate));
let root = defaultRoots[0];
if (explicitRoot) root = path.resolve(explicitRoot);
else {
  for (const candidate of defaultRoots) {
    try {
      await access(candidate);
      root = candidate;
      break;
    } catch {
      // try the next known location
    }
  }
}
const records = [];
const errors = [];

try {
  await access(root);
} catch (error) {
  if (!explicitRoot && error.code === "ENOENT") {
    console.log("No private task workspace found; skipped task validation");
    process.exit(0);
  }
  throw error;
}

async function walk(directory, archived = false) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory())
      await walk(target, archived || entry.name === "archive");
    else if (entry.name === "task.md") await readTask(target, archived);
  }
}
async function readTask(file, archived) {
  const source = await readFile(file, "utf8");
  if (!source.startsWith("---\n"))
    return errors.push(`${file}: missing frontmatter`);
  const end = source.indexOf("\n---", 4);
  if (end < 0) return errors.push(`${file}: unterminated frontmatter`);
  const fields = Object.fromEntries(
    source
      .slice(4, end)
      .split("\n")
      .filter((line) => /^[\w-]+:/.test(line))
      .map((line) => {
        const separator = line.indexOf(":");
        return [line.slice(0, separator), line.slice(separator + 1).trim()];
      }),
  );
  const id = fields.id?.replace(/^['"]|['"]$/g, "");
  const directory = path.basename(path.dirname(file));
  if (!archived) {
    const legacy = Boolean(
      fields.goal || fields.opened_at || fields.updated_at,
    );
    const required = legacy
      ? ["id", "title", "state", "project", "goal"]
      : ["id", "title", "state", "project", "opened", "updated", "artifacts"];
    for (const field of required)
      if (!fields[field]) errors.push(`${file}: missing ${field}`);
    if (id && id !== directory)
      errors.push(`${file}: id does not match directory`);
    if (
      fields.state &&
      !["todo", "active", "paused", "blocked", "done", "cancelled"].includes(
        fields.state,
      )
    )
      errors.push(`${file}: invalid state`);
    if (legacy) {
      const checklist = source.match(/- "\[[ x]\] .*"/g) ?? [];
      if (!checklist.length) errors.push(`${file}: missing checklist`);
      if (
        fields.state === "done" &&
        checklist.some((line) => line.includes("[ ]"))
      )
        errors.push(`${file}: done task has unchecked work`);
    } else {
      for (const heading of [
        "Objective",
        "Definition of done",
        "Next action",
        "Verification",
        "Blockers",
        "Log",
      ])
        if (!source.includes(`\n## ${heading}\n`))
          errors.push(`${file}: missing ${heading} section`);
    }
  }
  records.push({ id, file, archived, fields });
}

await walk(root);
const live = records.filter((record) => !record.archived);
const liveIds = new Set();
for (const record of live) {
  if (liveIds.has(record.id)) errors.push(`duplicate live task: ${record.id}`);
  liveIds.add(record.id);
}
const knownIds = new Set(records.map((record) => record.id));
if (knownIds.size !== records.length) {
  const counts = new Map();
  for (const record of records)
    counts.set(record.id, (counts.get(record.id) ?? 0) + 1);
  for (const [id, count] of counts)
    if (count > 1)
      errors.push(`duplicate task id across live/archive records: ${id}`);
}
// A renumbered task keeps its old id in `legacyId`, so references written before still resolve.
for (const record of records)
  if (record.fields.legacyId) knownIds.add(record.fields.legacyId);
for (const record of records) {
  const refs = [
    ...(record.fields.references?.match(/\b[A-Z][A-Z0-9]{0,5}-\d+\b/g) ?? []),
  ];
  for (const ref of refs)
    if (!knownIds.has(ref))
      errors.push(`${record.file}: broken reference ${ref}`);
}
// Nothing closes tasks on its own (no watcher): a `done` task left in the live tree needs
// `ocean tasks archive --apply`. A warning, not an error, so a hand-edit never blocks a build.
for (const record of live.filter((entry) => entry.fields.state === "done"))
  console.warn(
    `${record.file}: done but not archived (run: ocean tasks archive --apply)`,
  );
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(
  `Validated ${live.length} live and ${records.length - live.length} archived tasks`,
);
