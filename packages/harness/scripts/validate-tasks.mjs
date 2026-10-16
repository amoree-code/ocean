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
// A claim is advisory: `claimed_by` + `claimed_at` (+ optional `claimed_paths`) in a live task's
// frontmatter say "a session is working on this". It goes stale after CLAIM_TTL_MS so a dead
// session cannot hold a task forever. Keep this value equal to CLAIM_TTL_MS in
// src/application/tasks/claim-task.ts.
const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;
const unquote = (value) => value?.replace(/^['"]|['"]$/g, "");
function parseClaimPaths(raw) {
  const match = raw?.match(/^\[(.*)\]$/);
  if (!match) return null;
  return match[1]
    .split(",")
    .map((entry) =>
      unquote(entry.trim()).replace(/^\.\//, "").replace(/\/+$/, ""),
    )
    .filter(Boolean);
}
const pathsOverlap = (a, b) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const claims = [];

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
function readClaim(file, fields) {
  const by = unquote(fields.claimed_by);
  const at = unquote(fields.claimed_at);
  if (!by && !at && !fields.claimed_paths) return;
  if (!by || !at)
    return errors.push(`${file}: a claim needs both claimed_by and claimed_at`);
  const claimedAt = /^\d{4}-\d\d-\d\dT/.test(at) ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(claimedAt))
    return errors.push(`${file}: claimed_at is not an ISO-8601 timestamp`);
  let paths = [];
  if (fields.claimed_paths) {
    const parsed = parseClaimPaths(fields.claimed_paths);
    if (!parsed)
      return errors.push(
        `${file}: claimed_paths must be an inline list: [a, b]`,
      );
    paths = parsed;
  }
  if (["done", "cancelled"].includes(fields.state))
    console.warn(
      `${file}: ${fields.state} task still claimed by ${by} (release it)`,
    );
  else if (Date.now() - claimedAt > CLAIM_TTL_MS)
    console.warn(
      `${file}: stale claim by ${by} since ${at} (ocean tasks release)`,
    );
  else claims.push({ file, id: unquote(fields.id), by, paths });
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
    readClaim(file, fields);
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
// Two live claims by different owners must not cover the same path (equal, or one inside the other).
for (let i = 0; i < claims.length; i++)
  for (let j = i + 1; j < claims.length; j++) {
    const [a, b] = [claims[i], claims[j]];
    if (a.by === b.by) continue;
    for (const pa of a.paths)
      for (const pb of b.paths)
        if (pathsOverlap(pa, pb))
          errors.push(
            `claim conflict on ${pa}: ${a.id} (${a.by}) overlaps ${b.id} (${b.by}) on ${pb}`,
          );
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
