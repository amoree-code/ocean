import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import {
  atomicWrite,
  parseFrontmatter,
  withFileLock,
} from "@ocean/core/shared/fs-utils.js";
import {
  KNOWLEDGE_DIR,
  oceanPath,
  SYSTEM_DIR,
} from "@ocean/core/shared/paths.js";

// The one store for what Ocean learned from Ameer's work (T-230): one markdown record per
// lesson under 05-knowledge/lessons/. Confidence is stored at `confidence_at` and decays on
// read, so a lesson nobody confirms fades without any job rewriting files.
export type LessonStatus = "candidate" | "active" | "retired";

export type Lesson = {
  id: string;
  title: string;
  body: string;
  status: LessonStatus;
  confidence: number;
  confidenceAt: string;
  hits: number;
  evidence: string[];
  created: string;
  lastConfirmedAt: string | null;
  sourceSessionId: string | null;
};

export type NewLesson = {
  id: string;
  title: string;
  body: string;
  confidence?: number;
  evidence?: string[];
  status?: LessonStatus;
  sourceSessionId?: string;
};

export const LESSON_HALF_LIFE_DAYS = 30;
const CONFIRM_STEP = 0.1;
const CONTRADICT_FACTOR = 0.5;
const RETIRE_BELOW = 0.1;
const MAX_BODY_CHARS = 32_000;
const MAX_EVIDENCE = 20;
const DAY_MS = 86_400_000;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/;
const SECRET_PATTERN = /(api[_ -]?key|token|password|secret)\s*[:=]/i;

export const lessonsDir = () => oceanPath(KNOWLEDGE_DIR, "lessons");
const lessonFile = (id: string) => path.join(lessonsDir(), `${id}.md`);
const conflictsFile = () => path.join(lessonsDir(), "CONFLICTS.md");

const clamp = (value: number) => Math.min(1, Math.max(0, value));

// Confidence as of `now`: halves every LESSON_HALF_LIFE_DAYS since it was last written.
export function effectiveConfidence(
  lesson: Pick<Lesson, "confidence" | "confidenceAt">,
  now: Date = new Date(),
): number {
  const anchor = Date.parse(lesson.confidenceAt);
  const ageDays = Number.isNaN(anchor)
    ? 0
    : Math.max(0, (now.getTime() - anchor) / DAY_MS);
  return lesson.confidence * 0.5 ** (ageDays / LESSON_HALF_LIFE_DAYS);
}

function serialize(lesson: Lesson): string {
  const summary = lesson.body.replace(/\s+/g, " ").trim().slice(0, 200);
  const fields: Array<[string, string]> = [
    ["id", lesson.id],
    ["title", JSON.stringify(lesson.title)],
    ["summary", JSON.stringify(summary)],
    ["type", "experiential"],
    ["status", lesson.status],
    ["confidence", lesson.confidence.toFixed(4)],
    ["confidence_at", lesson.confidenceAt],
    ["hits", String(lesson.hits)],
    ["evidence", JSON.stringify(lesson.evidence)],
    ["scope", "global"],
    ["created", lesson.created],
    ["last_confirmed_at", lesson.lastConfirmedAt ?? ""],
    ["source_session", lesson.sourceSessionId ?? ""],
  ];
  const head = fields
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return `---\n${head}\n---\n\n${lesson.body.trim()}\n`;
}

function parse(source: string): Lesson | null {
  const fields = parseFrontmatter(source);
  if (fields.type !== "experiential" || !fields.id) return null;
  const status = fields.status as LessonStatus;
  if (!["candidate", "active", "retired"].includes(status)) return null;
  let evidence: string[] = [];
  try {
    const parsed = JSON.parse(fields.evidence ?? "[]");
    if (Array.isArray(parsed)) evidence = parsed.map(String);
  } catch {
    // A hand-edited, unparseable list is treated as no evidence rather than a lost lesson.
  }
  const normalized = source.replace(/\r\n/g, "\n");
  const end = normalized.indexOf("\n---", 3);
  return {
    id: fields.id,
    title: unquote(fields.title ?? fields.id),
    body: (end < 0 ? "" : normalized.slice(end + 4)).trim(),
    status,
    confidence: clamp(Number(fields.confidence) || 0),
    confidenceAt: fields.confidence_at || fields.created || "",
    hits: Math.max(0, Math.trunc(Number(fields.hits) || 0)),
    evidence,
    created: fields.created ?? "",
    lastConfirmedAt: fields.last_confirmed_at || null,
    sourceSessionId: fields.source_session || null,
  };
}

// parseFrontmatter strips only the outer quotes; JSON-encoded values keep inner escapes.
function unquote(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

// A lesson the store refuses on its own terms (as opposed to an I/O failure): the migration
// skips these and surfaces everything else.
export class LessonRejectedError extends Error {}

function assertClean(...texts: Array<string | undefined>): void {
  if (texts.some((text) => text !== undefined && SECRET_PATTERN.test(text)))
    throw new LessonRejectedError("Invalid or sensitive lesson");
}

function assertValid(input: NewLesson): void {
  if (
    !ID_PATTERN.test(input.id) ||
    !input.title.trim() ||
    !input.body.trim() ||
    input.body.length > MAX_BODY_CHARS
  )
    throw new LessonRejectedError("Invalid or sensitive lesson");
  assertClean(input.title, input.body, ...(input.evidence ?? []));
}

export async function readLesson(id: string): Promise<Lesson | null> {
  if (!ID_PATTERN.test(id)) return null;
  try {
    return parse(await readFile(lessonFile(id), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function listLessons(
  filter: { status?: LessonStatus } = {},
): Promise<Lesson[]> {
  let names: string[];
  try {
    names = await readdir(lessonsDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const lessons: Lesson[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".md") || name === "CONFLICTS.md") continue;
    const lesson = await readLesson(name.slice(0, -3));
    if (lesson && (!filter.status || lesson.status === filter.status))
      lessons.push(lesson);
  }
  return lessons;
}

async function write(lesson: Lesson): Promise<void> {
  await mkdir(lessonsDir(), { recursive: true });
  await atomicWrite(lessonFile(lesson.id), serialize(lesson), 0o600);
}

export async function addLesson(
  input: NewLesson,
  now: Date = new Date(),
): Promise<Lesson> {
  assertValid(input);
  const stamp = now.toISOString();
  return withFileLock(lessonFile(input.id), async () => {
    if (await readLesson(input.id))
      throw new LessonRejectedError("Duplicate lesson");
    const lesson: Lesson = {
      id: input.id,
      title: input.title.trim(),
      body: input.body.trim(),
      status: input.status ?? "candidate",
      confidence: clamp(input.confidence ?? 0.5),
      confidenceAt: stamp,
      hits: 0,
      evidence: (input.evidence ?? []).slice(0, MAX_EVIDENCE),
      created: stamp,
      lastConfirmedAt: null,
      sourceSessionId: input.sourceSessionId ?? null,
    };
    await write(lesson);
    return lesson;
  });
}

async function update(
  id: string,
  change: (lesson: Lesson) => void | Promise<void>,
): Promise<Lesson> {
  return withFileLock(lessonFile(id), async () => {
    const lesson = await readLesson(id);
    if (!lesson) throw new Error(`Lesson not found: ${id}`);
    await change(lesson);
    await write(lesson);
    return lesson;
  });
}

// Confirmation on use: a verified use is a hit, restores the decayed confidence and a
// little more, and restarts the decay clock.
export async function confirmLesson(
  id: string,
  options: { evidence?: string; now?: Date } = {},
): Promise<Lesson> {
  const now = options.now ?? new Date();
  assertClean(options.evidence);
  return update(id, (lesson) => {
    lesson.confidence = clamp(effectiveConfidence(lesson, now) + CONFIRM_STEP);
    lesson.confidenceAt = now.toISOString();
    lesson.lastConfirmedAt = now.toISOString();
    lesson.hits += 1;
    if (options.evidence && !lesson.evidence.includes(options.evidence))
      lesson.evidence = [...lesson.evidence, options.evidence].slice(
        -MAX_EVIDENCE,
      );
  });
}

// The only way a lesson changes status outside contradiction. Callers own the rule that
// justifies the move (see lesson-learning.ts for candidate → active).
export async function setLessonStatus(
  id: string,
  status: LessonStatus,
): Promise<Lesson> {
  return update(id, (lesson) => {
    lesson.status = status;
  });
}

// A contradicted fact loses confidence, the disagreement is written to CONFLICTS.md for
// the owner, and a lesson that falls below RETIRE_BELOW is retired (kept, never deleted).
export async function contradictLesson(
  id: string,
  options: { reason: string; evidence?: string; now?: Date },
): Promise<Lesson> {
  const now = options.now ?? new Date();
  assertClean(options.reason, options.evidence);
  let entry = "";
  const lesson = await update(id, (current) => {
    const before = effectiveConfidence(current, now);
    current.confidence = clamp(before * CONTRADICT_FACTOR);
    current.confidenceAt = now.toISOString();
    if (options.evidence && !current.evidence.includes(options.evidence))
      current.evidence = [...current.evidence, options.evidence].slice(
        -MAX_EVIDENCE,
      );
    if (current.confidence < RETIRE_BELOW) current.status = "retired";
    const reason = options.reason.replace(/\s+/g, " ").trim().slice(0, 500);
    entry =
      `- ${now.toISOString()} \`${current.id}\` contradicted: ${reason}` +
      ` (confidence ${before.toFixed(2)} → ${current.confidence.toFixed(2)}` +
      `${current.status === "retired" ? ", retired" : ""}` +
      `${options.evidence ? `; evidence ${options.evidence}` : ""})\n`;
  });
  // After the lesson is written, so the log never records a change that did not happen.
  await appendConflict(entry);
  return lesson;
}

async function appendConflict(line: string): Promise<void> {
  await mkdir(lessonsDir(), { recursive: true });
  await withFileLock(conflictsFile(), async () => {
    const current = await readFile(conflictsFile(), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT")
          return "# Lesson conflicts\n\nContradicted lessons, newest last. Resolve by hand.\n\n";
        throw error;
      },
    );
    await atomicWrite(conflictsFile(), `${current}${line}`, 0o600);
  });
}

type LegacyObservation = {
  observationId?: string;
  sourceSessionId?: string;
  summary?: string;
  evidenceRefs?: string[];
  confidence?: number;
  status?: string;
  skillCandidateId?: string | null;
};
type LegacyCandidate = {
  id?: string;
  name?: string;
  instructions?: string;
  status?: string;
  verification?: string;
  sourceSessionId?: string;
};

async function readLegacy<T>(file: string): Promise<T[] | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(parsed))
      throw new Error(`Legacy lesson store is not a JSON array: ${file}`);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export type LessonMigration = { migrated: number; skipped: number };

// `lesson-<id>`, lowercased to the id alphabet. A raw id that does not survive that unchanged
// (or is too long) gets a hash suffix so two distinct legacy ids can never collide.
function legacyLessonId(raw: string): string {
  const slug = `lesson-${raw}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (slug === `lesson-${raw}` && slug.length <= 70) return slug;
  return `${slug.slice(0, 60)}-${createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
}

// Folds the two legacy lesson stores (skills/observations.json and skills/candidates.json)
// into lessons, then renames each to `*.migrated` — never deleted. Idempotent: an existing
// lesson id is skipped, and a renamed file is not read again. `system/observations/*.json`
// is not migrated: those are raw `ocean observe` command logs, evidence a lesson can cite.
export async function migrateLegacyLessons(
  now: Date = new Date(),
): Promise<LessonMigration> {
  const skillsDir = oceanPath(SYSTEM_DIR, "skills");
  const observationsFile = path.join(skillsDir, "observations.json");
  const candidatesFile = path.join(skillsDir, "candidates.json");
  const result: LessonMigration = { migrated: 0, skipped: 0 };
  const put = async (input: NewLesson, retired: boolean) => {
    try {
      await addLesson(
        { ...input, status: retired ? "retired" : input.status },
        now,
      );
      result.migrated += 1;
    } catch (error) {
      if (!(error instanceof LessonRejectedError)) throw error;
      result.skipped += 1;
    }
  };

  // Both files are read before anything is written: a corrupt one aborts a clean no-op.
  const candidates = await readLegacy<LegacyCandidate>(candidatesFile);
  const observations = await readLegacy<LegacyObservation>(observationsFile);
  const covered = new Set<string>();
  for (const item of candidates ?? []) {
    if (!item.id || !item.instructions) {
      result.skipped += 1;
      continue;
    }
    covered.add(item.id);
    const promoted =
      item.status === "promoted" && item.verification === "owner-reviewed";
    await put(
      {
        id: legacyLessonId(item.id),
        title: item.name ?? item.id,
        body: item.instructions,
        status: promoted ? "active" : "candidate",
        confidence: promoted ? 0.8 : 0.5,
        sourceSessionId: item.sourceSessionId,
      },
      item.status === "rejected",
    );
  }

  for (const item of observations ?? []) {
    if (!item.observationId || !item.summary) {
      result.skipped += 1;
      continue;
    }
    // An approved observation already became a candidate; that candidate is the lesson.
    if (item.skillCandidateId && covered.has(item.skillCandidateId)) {
      result.skipped += 1;
      continue;
    }
    await put(
      {
        id: legacyLessonId(item.observationId),
        title: item.summary.slice(0, 80),
        body: item.summary,
        confidence: item.confidence,
        evidence: item.evidenceRefs,
        sourceSessionId: item.sourceSessionId,
      },
      item.status === "discarded" || item.status === "rejected",
    );
  }

  for (const [file, existed] of [
    [candidatesFile, candidates],
    [observationsFile, observations],
  ] as const)
    if (existed) await rename(file, `${file}.migrated`);
  return result;
}
