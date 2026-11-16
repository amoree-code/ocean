import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactRuntimeText } from "@ocean/core/domain/redaction/redaction.js";
import type {
  Session,
  SessionEvent,
} from "@ocean/core/domain/sessions/session.js";
import {
  localDate,
  localMoment,
  localTime,
} from "@ocean/core/shared/local-date.js";
import {
  DAILY_DIR,
  INBOX_DIR,
  oceanPath,
  oceanRoot,
} from "@ocean/core/shared/paths.js";
import { findGitRoot } from "@ocean/core/shared/project-resolution.js";
import type { LearnedSignal } from "./lesson-learning.js";
import type { ModelNarrative } from "./model-narrative.js";
import type { SessionDigest } from "./session-facts.js";

// Same fallback title stamped on a session with no explicit title (see
// daily-narrative.ts) — never meaningful content on its own.
const GENERIC_TITLE =
  /^(claude|codex|hermes|kimi|gemini|copilot|kilo|antigravity|openhands) session$/i;

function safeText(value: string, max = 400): string {
  return redactRuntimeText(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function isGenericContent(text: string | null | undefined): boolean {
  const trimmed = (text ?? "").trim();
  return trimmed.length === 0 || GENERIC_TITLE.test(trimmed);
}

const MIN_USEFUL_SLUG_LENGTH = 3;

// ASCII-only by design: ranks a Latin-alphabet slug of the title over one
// derived from the (already ASCII) project name, and falls back to the
// session id only when both are too short to be useful — e.g. a title in a
// non-Latin script, where this strips down to nothing.
function slugify(text: string, maxLength = 60): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

async function uniqueFilename(
  directory: string,
  base: string,
  ext: string,
): Promise<string> {
  let existing: Set<string>;
  try {
    existing = new Set(await readdir(directory));
  } catch {
    existing = new Set();
  }
  if (!existing.has(`${base}${ext}`)) return `${base}${ext}`;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${base}-${suffix}${ext}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}${ext}`;
}

/**
 * One session record per session in 01-daily/sessions/YYYY-MM/ (T-314; was 00-inbox/brain-dump/),
 * separate from the machine-oriented kernel/bridge/sessions/summaries/ dump. Prefers
 * the cheap model narrative (see model-narrative.ts) and falls back to the
 * same deterministic heuristics as daily-narrative.ts when it is unavailable.
 * When lesson-learning.ts already found signals for this session (corrections,
 * repeated procedures, explicit decisions), they're mirrored under
 * "## Signals" — the same events already surfaced in brain/01-daily/, so a
 * later cross-session sweep has one place to look instead of two.
 *
 * Skipped for the same low-value case daily-narrative.ts skips: a generic
 * title with no real (git) project behind it — nothing a human would want to
 * read later.
 */
export async function writeBrainDump(input: {
  session: Session;
  events: SessionEvent[];
  changedFiles: string[];
  exitCode?: number;
  nextAction?: string;
  narrative?: ModelNarrative | null;
  observations?: LearnedSignal[];
}): Promise<{ brainDumpPath: string } | null> {
  const { session, events, narrative, changedFiles, observations } = input;

  const workLog =
    narrative?.workLog ??
    (() => {
      const objectiveEvent = events.find(
        (event) =>
          event.type === "user_input" || event.type === "resume_requested",
      );
      return safeText(objectiveEvent?.data ?? session.title, 200);
    })();

  const hasRealProject = findGitRoot(session.workingDirectory) !== null;
  if (isGenericContent(workLog) && !hasRealProject) return null;

  const decision =
    narrative?.decision ??
    events
      .filter(
        (event) =>
          event.type === "provider_output" ||
          event.type === "text" ||
          event.type === "json",
      )
      .map((event) => safeText(event.data, 500))
      .find((text) => /\bdecision\s*:/i.test(text));

  const problem =
    narrative?.problem ??
    events
      .filter(
        (event) => event.type === "error" || event.type === "provider_blocked",
      )
      .map((event) => safeText(event.data, 500))[0];

  const nextAction = narrative?.next ?? input.nextAction ?? session.nextAction;
  const hasNextAction =
    nextAction &&
    nextAction !== "Review the summary and verify the next action.";

  const started = localMoment(session.createdAt);
  const time = localTime(started);
  const date = localDate(started);
  const project =
    path.basename(session.workingDirectory) || session.workingDirectory;
  const status =
    session.status === "completed" && (input.exitCode ?? 0) === 0
      ? "completed"
      : "failed";
  const title = isGenericContent(workLog) ? project : workLog;

  // A session record (T-314): flat frontmatter Obsidian can read, then fixed sections. The
  // narrative comes from one model call when there was one; otherwise from the events.
  const quote = (value: string) => JSON.stringify(value);
  const lines = [
    "---",
    "type: session",
    `project: ${quote(project)}`,
    `provider: ${quote(session.provider)}`,
    `status: ${status}`,
    `session_id: ${quote(session.sessionId)}`,
    `date: ${date}`,
    "tags: []",
    "distilled: false",
    "---",
    "",
    `# ${title}`,
    "",
    "## Goal",
    "",
    workLog || "No objective was captured.",
    "",
    "## Outcome",
    "",
    status === "completed" ? "Completed." : "Did not complete.",
    ...(decision ? ["", "## Decisions", "", decision] : []),
    ...(problem ? ["", "## Problems → fixes", "", problem] : []),
    ...(observations?.length
      ? [
          "",
          "## Learned",
          "",
          ...observations.map(
            (o) =>
              `- [${o.signalType}] ${safeText(o.summary, 300)} (confidence ${o.confidence})`,
          ),
        ]
      : []),
    "",
    "## Verification",
    "",
    status === "completed" && (input.exitCode ?? 0) === 0
      ? "NOT PROVEN — the session ended cleanly; no check is recorded here."
      : `NOT PROVEN — exit code ${input.exitCode ?? "unknown"}.`,
    ...(changedFiles.length
      ? [
          "",
          "## Files / commits",
          "",
          ...changedFiles.map((f) => `- ${safeText(f, 240)}`),
        ]
      : []),
    ...(hasNextAction
      ? ["", "## Next", "", safeText(nextAction as string, 300)]
      : []),
    "",
    `Raw events: \`ocean session events ${session.sessionId}\``,
  ];

  // 01-daily/sessions/YYYY-MM/, where the session-record template and Templater point.
  const directory = oceanPath(DAILY_DIR, "sessions", date.slice(0, 7));
  await mkdir(directory, { recursive: true });

  const titleSlug = slugify(title);
  const slug =
    titleSlug.length >= MIN_USEFUL_SLUG_LENGTH
      ? titleSlug
      : slugify(project).length >= MIN_USEFUL_SLUG_LENGTH
        ? slugify(project)
        : session.sessionId.slice(0, 8);
  const filename = await uniqueFilename(
    directory,
    `${date}-${time.replace(":", "")}-${slug}`,
    ".md",
  );
  const file = path.join(directory, filename);
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  return {
    brainDumpPath: path.relative(oceanRoot(), file).split(path.sep).join("/"),
  };
}

// The one-time move (T-314): brain-dump files written before session records become records,
// moved — never deleted — to 01-daily/sessions/YYYY-MM/ by the date in their name, with a
// `type: session` frontmatter added when they have none. Dry run unless `apply`; a target that
// already exists is left alone and reported.
export async function migrateBrainDumps(options: { apply: boolean }): Promise<{
  moved: string[];
  skipped: string[];
}> {
  const source = oceanPath(INBOX_DIR, "brain-dump");
  const names = await readdir(source).catch(() => [] as string[]);
  const moved: string[] = [];
  const skipped: string[] = [];
  for (const name of names.sort()) {
    const date = /^(\d{4}-\d{2}-\d{2})-/.exec(name)?.[1];
    if (!name.endsWith(".md") || !date) continue;
    const relative = `${DAILY_DIR}/sessions/${date.slice(0, 7)}/${name}`;
    const target = oceanPath(relative);
    if (
      await readFile(target).then(
        () => true,
        () => false,
      )
    ) {
      skipped.push(relative);
      continue;
    }
    moved.push(relative);
    if (!options.apply) continue;
    const text = await readFile(path.join(source, name), "utf8");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      text.startsWith("---")
        ? text
        : `---\ntype: session\ndate: ${date}\nstatus: legacy\ndistilled: false\n---\n\n${text}`,
      "utf8",
    );
    await rm(path.join(source, name));
  }
  return { moved, skipped };
}

// A chat with no session in the store (Claude Desktop, an export: T-314) gets the same record, from
// the digest its fact extraction returned — no model call of its own. One record per captured
// stretch of the conversation, dated by its newest message.
export async function writeDigestRecord(input: {
  provider: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  digest: SessionDigest;
  project?: string;
}): Promise<{ path: string }> {
  const { digest } = input;
  const date = localDate(localMoment(input.endedAt));
  const time = localTime(localMoment(input.startedAt));
  const title = safeText(digest.title || digest.goal, 120) || "Conversation";
  const quote = (value: string) => JSON.stringify(value);
  const list = (heading: string, items: string[]) =>
    items.length
      ? [
          "",
          `## ${heading}`,
          "",
          ...items.map((item) => `- ${safeText(item, 300)}`),
        ]
      : [];
  const lines = [
    "---",
    "type: session",
    `project: ${quote(input.project ?? "")}`,
    `provider: ${quote(input.provider)}`,
    "status: completed",
    `session_id: ${quote(input.sessionId)}`,
    `date: ${date}`,
    "tags: []",
    "distilled: false",
    "---",
    "",
    `# ${title}`,
    "",
    "## Goal",
    "",
    safeText(digest.goal, 300) || "Not stated.",
    "",
    "## Outcome",
    "",
    safeText(digest.outcome, 300) || "Not stated.",
    ...list("Decisions", digest.decisions),
    ...list("Problems → fixes", digest.fixes),
    ...list("Learned", digest.learned),
    "",
    "## Verification",
    "",
    "NOT PROVEN — summarized from a chat; nothing was run.",
    ...list("Next", digest.next),
    "",
  ];
  const directory = oceanPath(DAILY_DIR, "sessions", date.slice(0, 7));
  await mkdir(directory, { recursive: true });
  const filename = await uniqueFilename(
    directory,
    `${date}-${time.replace(":", "")}-${slugify(title).length >= MIN_USEFUL_SLUG_LENGTH ? slugify(title) : input.provider}`,
    ".md",
  );
  const file = path.join(directory, filename);
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  return { path: path.relative(oceanRoot(), file).split(path.sep).join("/") };
}
