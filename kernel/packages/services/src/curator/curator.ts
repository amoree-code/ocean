import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { appendAudit, sha256 } from "@ocean/brain/memory/memory-audit.js";
import { atomicWrite, parseFrontmatter } from "@ocean/core/shared/fs-utils.js";
import {
  KNOWLEDGE_DIR,
  oceanPath,
  SYSTEM_DIR,
} from "@ocean/core/shared/paths.js";
import { setFrontmatterFields } from "@ocean/loop/tasks/task-verification.js";

// The curator (T-322, Hermes pattern): a lesson or skill not used for 30 days is marked `stale`,
// for 90 days `archived`; one not reviewed for 90 days is marked `stale` too (forge F8). Every
// change is reversible with `review`, which stamps `last_reviewed` and restores the status it had.
// Lessons archive into lessons/archive/ (the index never walks it); skills are only marked, never
// moved, because client skill folders are synced from bridge/skills/.
//
// No client records a use yet (T-323), so an item's clock starts the first night the curator
// sees it (bridge/state/curator.json): missing data is never read as "unused".

export const STALE_DAYS = 30;
export const ARCHIVE_DAYS = 90;
export const REVIEW_DAYS = 90;
const DAY_MS = 86_400_000;
const USE_FIELDS = [
  "last_used",
  "last_confirmed_at",
  "last_verified",
  "last_reviewed",
];
const CURATOR_STATES = new Set(["stale", "archived"]);

export type CuratedKind = "lesson" | "skill";
export type CuratedItem = {
  kind: CuratedKind;
  // `lesson:<file stem>` or `skill:<dir name>`.
  key: string;
  file: string;
};

export type CuratorAction = {
  key: string;
  action: "stale" | "archived" | "restored";
  reason: string;
};

const lessonsDir = () => oceanPath(KNOWLEDGE_DIR, "lessons");
const skillsDir = () => oceanPath(SYSTEM_DIR, "skills");
export const curatorStateFile = () =>
  oceanPath(SYSTEM_DIR, "state", "curator.json");

const dayOf = (value: string | undefined) =>
  value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
const daysBetween = (from: string, to: string) =>
  Math.floor((Date.parse(to) - Date.parse(from)) / DAY_MS);
const latest = (days: Array<string | null>) =>
  days
    .filter((day): day is string => day !== null)
    .sort()
    .at(-1) ?? null;

export async function listCurated(): Promise<CuratedItem[]> {
  const items: CuratedItem[] = [];
  const lessons = lessonsDir();
  for (const [dir, archived] of [
    [lessons, false],
    [path.join(lessons, "archive"), true],
  ] as const) {
    for (const name of (
      await readdir(dir).catch(() => [] as string[])
    ).sort()) {
      if (!name.endsWith(".md") || name === "CONFLICTS.md") continue;
      const file = path.join(dir, name);
      // Only lessons the curator archived come back from archive/; T-314 retirements stay there.
      if (archived) {
        const status = parseFrontmatter(await readFile(file, "utf8")).status;
        if (status !== "archived") continue;
      }
      items.push({ kind: "lesson", key: `lesson:${name.slice(0, -3)}`, file });
    }
  }
  for (const name of (
    await readdir(skillsDir()).catch(() => [] as string[])
  ).sort()) {
    const file = path.join(skillsDir(), name, "SKILL.md");
    if (await readFile(file, "utf8").catch(() => null))
      items.push({ kind: "skill", key: `skill:${name}`, file });
  }
  return items;
}

// What the curator would do to one item today, from its frontmatter and first-seen day.
export function judge(
  fields: Record<string, string>,
  firstSeen: string,
  today: string,
): { status: "fresh" | "stale" | "archived"; reason: string } {
  const lastUse = latest([
    firstSeen,
    ...USE_FIELDS.map((key) => dayOf(fields[key])),
  ]);
  const lastReview = latest([firstSeen, dayOf(fields.last_reviewed)]);
  const unused = lastUse ? daysBetween(lastUse, today) : 0;
  const unreviewed = lastReview ? daysBetween(lastReview, today) : 0;
  if (unused >= ARCHIVE_DAYS)
    return { status: "archived", reason: `unused ${unused} days` };
  if (unused >= STALE_DAYS)
    return { status: "stale", reason: `unused ${unused} days` };
  if (unreviewed >= REVIEW_DAYS)
    return { status: "stale", reason: `not reviewed for ${unreviewed} days` };
  return { status: "fresh", reason: "" };
}

function dropFields(source: string, keys: string[]): string {
  const end = source.indexOf("\n---", 4);
  if (!source.startsWith("---\n") || end < 0) return source;
  const kept = source
    .slice(4, end)
    .split("\n")
    .filter((line) => !keys.includes(line.match(/^([\w-]+):/)?.[1] ?? ""));
  return `---\n${kept.join("\n")}${source.slice(end)}`;
}

const archivePath = (item: CuratedItem) =>
  path.join(lessonsDir(), "archive", path.basename(item.file));
const livePath = (item: CuratedItem) =>
  path.join(lessonsDir(), path.basename(item.file));

// Lesson edits go through the memory audit, so the nightly drift check does not flag them.
async function writeAudited(
  item: CuratedItem,
  source: string,
  text: string,
  finalFile: string,
): Promise<void> {
  if (item.kind !== "lesson") return;
  await appendAudit({
    action: "update",
    path: path.relative(oceanPath(), finalFile).split(path.sep).join("/"),
    source: "curator",
    beforeSha: sha256(source),
    afterSha: sha256(text),
  });
}

async function mark(
  item: CuratedItem,
  source: string,
  status: "stale" | "archived",
  today: string,
): Promise<void> {
  const fields = parseFrontmatter(source);
  const from = CURATOR_STATES.has(fields.status ?? "")
    ? (fields.curator_from ?? "none")
    : (fields.status ?? "none");
  const text = setFrontmatterFields(source, {
    status,
    curator_from: from,
    curated_at: today,
  });
  if (item.kind === "lesson" && status === "archived") {
    await mkdir(path.dirname(archivePath(item)), { recursive: true });
    await atomicWrite(item.file, text);
    await rename(item.file, archivePath(item));
    await writeAudited(item, source, text, archivePath(item));
  } else {
    await atomicWrite(item.file, text);
    await writeAudited(item, source, text, item.file);
  }
}

async function restore(
  item: CuratedItem,
  source: string,
  today: string,
): Promise<string> {
  const fields = parseFrontmatter(source);
  const previous = fields.curator_from;
  let text = dropFields(source, ["curator_from", "curated_at"]);
  text =
    !previous || previous === "none"
      ? dropFields(text, ["status"])
      : setFrontmatterFields(text, { status: previous });
  text = setFrontmatterFields(text, { last_reviewed: today });
  await atomicWrite(item.file, text);
  let file = item.file;
  if (item.kind === "lesson" && item.file !== livePath(item)) {
    await rename(item.file, livePath(item));
    file = livePath(item);
  }
  await writeAudited(item, source, text, file);
  return file;
}

type State = { firstSeen: Record<string, string> };

async function readState(): Promise<State> {
  try {
    const saved = JSON.parse(await readFile(curatorStateFile(), "utf8"));
    return { firstSeen: saved.firstSeen ?? {} };
  } catch {
    return { firstSeen: {} };
  }
}

// One pass: record first sightings, then mark, archive or restore each item. Dry run unless apply.
export async function curate(options: {
  today: string;
  apply: boolean;
}): Promise<CuratorAction[]> {
  const state = await readState();
  const actions: CuratorAction[] = [];
  for (const item of await listCurated()) {
    state.firstSeen[item.key] ??= options.today;
    const source = await readFile(item.file, "utf8");
    const fields = parseFrontmatter(source);
    const current = CURATOR_STATES.has(fields.status ?? "")
      ? fields.status
      : "fresh";
    const verdict = judge(fields, state.firstSeen[item.key], options.today);
    if (verdict.status === current) continue;
    // A newer use or review lifts the mark; archived never steps back down to stale on its own.
    if (verdict.status === "fresh") {
      actions.push({
        key: item.key,
        action: "restored",
        reason: "used or reviewed again",
      });
      if (options.apply) await restore(item, source, options.today);
    } else if (!(current === "archived" && verdict.status === "stale")) {
      actions.push({
        key: item.key,
        action: verdict.status,
        reason: verdict.reason,
      });
      if (options.apply)
        await mark(item, source, verdict.status, options.today);
    }
  }
  if (options.apply) {
    await mkdir(path.dirname(curatorStateFile()), { recursive: true });
    await atomicWrite(
      curatorStateFile(),
      `${JSON.stringify(state, null, 2)}\n`,
    );
  }
  return actions;
}

// `ocean curator review <key>`: the owner looked at it — stamp last_reviewed, undo any mark.
export async function reviewCurated(
  key: string,
  today: string,
): Promise<{ key: string; file: string; restored: boolean }> {
  const item = (await listCurated()).find(
    (candidate) => candidate.key === key || candidate.key.endsWith(`:${key}`),
  );
  if (!item)
    throw new Error(`Not a lesson or skill the curator tracks: ${key}`);
  const source = await readFile(item.file, "utf8");
  const marked = CURATOR_STATES.has(parseFrontmatter(source).status ?? "");
  if (marked)
    return {
      key: item.key,
      file: await restore(item, source, today),
      restored: true,
    };
  const text = setFrontmatterFields(source, { last_reviewed: today });
  await atomicWrite(item.file, text);
  await writeAudited(item, source, text, item.file);
  return { key: item.key, file: item.file, restored: false };
}
