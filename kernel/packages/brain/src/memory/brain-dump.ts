import {
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { redactRuntimeText } from "@ocean/core/domain/redaction/redaction.js";
import type {
  Session,
  SessionEvent,
} from "@ocean/core/domain/sessions/session.js";
import {
  NO_PROJECT,
  type ProjectConfidence,
  type ProjectHow,
  sessionIdentity,
} from "@ocean/core/domain/sessions/session-identity.js";
import {
  ActivityTally,
  type ExtractionCost,
  mergeActivity,
  metadataLines,
  readMetadata,
  type SessionActivity,
} from "@ocean/core/domain/sessions/session-metadata.js";
import { cleanTitle } from "@ocean/core/shared/clean-title.js";
import {
  parseFrontmatter,
  safeJsonParse,
} from "@ocean/core/shared/fs-utils.js";
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
import {
  findGitRoot,
  gitBranch,
  repoRelative,
} from "@ocean/core/shared/project-resolution.js";
import type { LearnedSignal } from "./lesson-learning.js";
import { isTrivialSession, type ModelNarrative } from "./model-narrative.js";
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

// Blocks a client wraps around or slips in front of the user's words — system notes, IDE state,
// slash-command echoes, background-task notices. Never the goal of a session (T-326).
const WRAPPER_TAGS =
  "system-reminder|task-notification|ide_[a-z_]+|command-[a-z-]+|local-command-[a-z-]+|browser_instruction|user-prompt-submit-hook";
const WRAPPER_BLOCK = new RegExp(
  `<(${WRAPPER_TAGS})\\b[^>]*>[\\s\\S]*?</\\1>`,
  "gi",
);
const WRAPPER_START = new RegExp(`^<(${WRAPPER_TAGS})\\b`, "i");

/** The user's own words in a message, or "" when it was only client wrapping. */
export function withoutWrappers(text: string): string {
  const stripped = text.replace(WRAPPER_BLOCK, " ").trim();
  return WRAPPER_START.test(stripped) ? "" : stripped;
}

type SessionRecord = { file: string; text: string };

const RECORD_HEAD_BYTES = 1024;

async function recordHead(file: string): Promise<string> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return "";
  try {
    const buffer = Buffer.alloc(RECORD_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, RECORD_HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * The live record of one session in 01-daily/sessions/YYYY-MM/ (archive/ is history and is never
 * rewritten). When an older duplicate exists, the digest record wins over a closeout one.
 */
export async function findSessionRecord(
  sessionId: string,
): Promise<SessionRecord | null> {
  const root = oceanPath(DAILY_DIR, "sessions");
  const needle = `session_id: ${JSON.stringify(sessionId)}`;
  const months = (await readdir(root).catch(() => [] as string[]))
    .filter((name) => /^\d{4}-\d{2}$/.test(name))
    .sort()
    .reverse();
  const found: SessionRecord[] = [];
  for (const month of months) {
    const directory = path.join(root, month);
    for (const name of (
      await readdir(directory).catch(() => [] as string[])
    ).sort()) {
      if (!name.endsWith(".md")) continue;
      const file = path.join(directory, name);
      if (!(await recordHead(file)).split("\n").includes(needle)) continue;
      found.push({ file, text: await readFile(file, "utf8") });
    }
  }
  return (
    found.find((record) => isDigestRecord(record.text)) ?? found[0] ?? null
  );
}

// Records written before `source:` existed carry the chat summary's verification line instead.
export function isDigestRecord(text: string): boolean {
  return (
    /^source: "digest"$/m.test(text) ||
    text.includes("NOT PROVEN — summarized from a chat")
  );
}

const PLACEHOLDER = /^(not stated\.?|no objective was captured\.?)$/i;

/** A digest record read back into the digest it was written from. */
export function recordDigest(text: string): SessionDigest {
  const section = (heading: string) => {
    const start = text.indexOf(`\n## ${heading}\n`);
    if (start < 0) return "";
    const body = text.slice(start + heading.length + 5);
    const end = body.search(/\n## |\n---\n|\nRaw events:/);
    return (end < 0 ? body : body.slice(0, end)).trim();
  };
  const prose = (heading: string) => {
    const value = section(heading);
    return PLACEHOLDER.test(value) ? "" : value;
  };
  const items = (heading: string) =>
    section(heading)
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).trim())
      .filter(Boolean);
  return {
    title: /^# (.+)$/m.exec(text)?.[1]?.trim() ?? "",
    goal: prose("Goal"),
    outcome: prose("Outcome"),
    decisions: items("Decisions"),
    fixes: items("Problems → fixes"),
    learned: items("Learned"),
    next: items("Next"),
  };
}

const MERGED_ITEMS = 5;

/**
 * Two stretches of one conversation as one account: what it set out to do comes from the first,
 * where it ended from the latest, and what remains to do only from the latest that said anything.
 */
export function mergeDigests(
  earlier: SessionDigest,
  later: SessionDigest,
): SessionDigest {
  const union = (a: string[], b: string[]) =>
    [...new Set([...a, ...b])].slice(-MERGED_ITEMS);
  return {
    title: earlier.title || later.title,
    goal: earlier.goal || later.goal,
    outcome: later.outcome || earlier.outcome,
    decisions: union(earlier.decisions, later.decisions),
    fixes: union(earlier.fixes, later.fixes),
    learned: union(earlier.learned, later.learned),
    next: (later.next.length ? later.next : earlier.next).slice(
      0,
      MERGED_ITEMS,
    ),
  };
}

// What an intercepted CLI session did, from its store events and the files git shows changed
// (T-334). The store keeps the user's turns and Ocean's own MCP calls, not each assistant reply
// or the client's tool calls, so those keys are left out rather than guessed.
function closeoutActivity(
  session: Session,
  events: SessionEvent[],
  changedFiles: string[],
): SessionActivity {
  const tally = new ActivityTally();
  for (const event of events) {
    if (
      (event.type === "user_input" || event.type === "resume_requested") &&
      withoutWrappers(event.data)
    )
      tally.turn("user");
    if (event.type === "mcp_tool_call") {
      const tool = safeJsonParse(event.data)?.tool;
      if (typeof tool === "string") tally.tool(tool);
    }
  }
  const { turnsUser, tools } = tally.result();
  const root = findGitRoot(session.workingDirectory);
  const files: Record<string, number> = {};
  for (const line of changedFiles) {
    // A `git status --short` line: status letters, then the path (a rename names both).
    const named = line
      .replace(/^[A-Z?!]{1,2}\s+/, "")
      .split(" -> ")
      .at(-1)
      ?.replace(/^"|"$/g, "");
    if (!named) continue;
    const file = repoRelative(
      path.resolve(session.workingDirectory, named),
      root,
    );
    files[file] = (files[file] ?? 0) + 1;
  }
  const branch = gitBranch(session.workingDirectory);
  return { turnsUser, tools, files, ...(branch ? { branch } : {}) };
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

  // One record per session (T-326): the chat digest's record is the richer account, so it wins;
  // a session that changed nothing and said nothing gets no record at all.
  const existing = await findSessionRecord(session.sessionId);
  if (existing && isDigestRecord(existing.text))
    return {
      brainDumpPath: path
        .relative(oceanRoot(), existing.file)
        .split(path.sep)
        .join("/"),
    };
  if (!narrative && isTrivialSession(events, changedFiles)) return null;

  // The first thing the user actually said, past any client wrapping.
  const workLog =
    narrative?.workLog ??
    (() => {
      for (const event of events) {
        if (event.type !== "user_input" && event.type !== "resume_requested")
          continue;
        const words = withoutWrappers(event.data);
        if (words) return safeText(words, 200);
      }
      return safeText(session.title, 200);
    })();

  const hasRealProject = findGitRoot(session.workingDirectory) !== null;
  if (isGenericContent(workLog) && !hasRealProject) return null;

  // Where the session ended: the assistant's last reply, else what it touched.
  const lastReply = [...events]
    .reverse()
    .filter(
      (event) => event.type === "provider_output" || event.type === "text",
    )
    .map((event) => safeText(withoutWrappers(event.data), 300))
    .find(Boolean);

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
  // The project and task decided when the session was created (T-331): "" when unbound.
  const identity = sessionIdentity(session, events);
  const project = identity.projectId;
  const status =
    session.status === "completed" && (input.exitCode ?? 0) === 0
      ? "completed"
      : "failed";
  const fallbackTitle = project || "Session";
  const title = !isGenericContent(workLog)
    ? cleanTitle(workLog, fallbackTitle)
    : lastReply
      ? cleanTitle(lastReply, fallbackTitle)
      : fallbackTitle;
  const outcome =
    status === "completed"
      ? (lastReply ??
        (changedFiles.length
          ? `Changed ${changedFiles.length} file(s).`
          : "Completed."))
      : `Did not complete.${lastReply ? ` ${lastReply}` : ""}`;

  // A session record (T-314): flat frontmatter Obsidian can read, then fixed sections. The
  // narrative comes from one model call when there was one; otherwise from the events.
  const quote = (value: string) => JSON.stringify(value);
  const lines = [
    "---",
    "type: session",
    `project: ${quote(project)}`,
    `task: ${quote(identity.taskId)}`,
    `provider: ${quote(session.provider)}`,
    'source: "closeout"',
    `status: ${status}`,
    `session_id: ${quote(session.sessionId)}`,
    ...metadataLines({
      projectHow: identity.how,
      projectConfidence: identity.confidence,
      started: session.createdAt,
      ended: session.closedAt ?? session.updatedAt,
      activity: closeoutActivity(session, events, changedFiles),
    }),
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
    outcome,
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
    // A clean exit proves nothing either way, so it says nothing; a failed one says how it ended.
    ...(status === "failed"
      ? [
          "",
          "## Verification",
          "",
          `NOT PROVEN — exit code ${input.exitCode ?? "unknown"}.`,
        ]
      : []),
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

  // A session closed out again (resumed, then ended) rewrites its own record.
  if (existing) {
    await writeFile(existing.file, `${lines.join("\n")}\n`, "utf8");
    return {
      brainDumpPath: path
        .relative(oceanRoot(), existing.file)
        .split(path.sep)
        .join("/"),
    };
  }

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

// A chat's record (Claude Desktop, an export, a Claude Code transcript: T-314) from the digest its
// fact extraction returned — no model call of its own. One record per session (T-326): a later
// stretch of the same conversation is merged into the record the first one wrote, and a thin
// closeout record for the session is replaced by this richer one.
export async function writeDigestRecord(input: {
  provider: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  digest: SessionDigest;
  // From the store session's identity (T-331); "" when unbound, never a folder name.
  project?: string;
  task?: string;
  // A Claude Desktop chat's own title and the Claude project it sits in (T-333).
  conversationTitle?: string;
  claudeProject?: string;
  // How the project was decided, what this stretch did and what reading it cost (T-334).
  identity?: { how: ProjectHow; confidence: ProjectConfidence };
  activity?: SessionActivity;
  extraction?: ExtractionCost;
}): Promise<{ path: string }> {
  const existing = await findSessionRecord(input.sessionId);
  const earlier =
    existing && isDigestRecord(existing.text)
      ? recordDigest(existing.text)
      : null;
  // A later stretch adds its counts and cost to the ones the record already carries.
  const before =
    earlier && existing ? readMetadata(parseFrontmatter(existing.text)) : {};
  const activity = mergeActivity(before.activity, input.activity);
  const extraction =
    before.extraction && input.extraction
      ? {
          model: input.extraction.model,
          inputChars:
            before.extraction.inputChars + input.extraction.inputChars,
          ms: before.extraction.ms + input.extraction.ms,
        }
      : (input.extraction ?? before.extraction);
  const identity =
    input.identity ??
    (input.project
      ? { how: "path" as const, confidence: "high" as const }
      : NO_PROJECT);
  const digest = earlier ? mergeDigests(earlier, input.digest) : input.digest;
  const existingDate = existing
    ? /^date: (\d{4}-\d{2}-\d{2})$/m.exec(existing.text)?.[1]
    : undefined;
  const date = existingDate ?? localDate(localMoment(input.endedAt));
  const time = localTime(localMoment(input.startedAt));
  // A later stretch keeps the start the first stretch recorded.
  const started =
    (existing ? /^started: "([^"]+)"$/m.exec(existing.text)?.[1] : undefined) ??
    input.startedAt;
  const title = cleanTitle(
    safeText(input.conversationTitle || digest.title || digest.goal, 400),
    input.project || "Conversation",
  );
  const quote = (value: string) => JSON.stringify(value);
  const optional = (key: string, value: string | undefined) =>
    value ? [`${key}: ${quote(safeText(value, 200))}`] : [];
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
    `task: ${quote(input.task ?? "")}`,
    `provider: ${quote(input.provider)}`,
    'source: "digest"',
    "status: completed",
    `session_id: ${quote(input.sessionId)}`,
    ...optional("conversation_title", input.conversationTitle),
    ...optional("claude_project", input.claudeProject),
    ...metadataLines({
      projectHow: identity.how,
      projectConfidence: identity.confidence,
      started,
      ended: input.endedAt,
      ...(activity ? { activity } : {}),
      ...(extraction ? { extraction } : {}),
    }),
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
    ...list("Next", digest.next),
    "",
  ];
  const slug =
    slugify(title).length >= MIN_USEFUL_SLUG_LENGTH
      ? slugify(title)
      : input.provider;
  let file: string;
  if (earlier && existing) {
    // A later stretch of the same chat: the record keeps its name, its day and its place.
    file = existing.file;
  } else if (existing) {
    // The thin closeout record for this session: replaced in place, renamed after the real title.
    const directory = path.dirname(existing.file);
    const stamp = /^\d{4}-\d{2}-\d{2}-\d{4}/.exec(
      path.basename(existing.file),
    )?.[0];
    await rm(existing.file, { force: true });
    file = path.join(
      directory,
      await uniqueFilename(
        directory,
        `${stamp ?? `${date}-${time.replace(":", "")}`}-${slug}`,
        ".md",
      ),
    );
  } else {
    const directory = oceanPath(DAILY_DIR, "sessions", date.slice(0, 7));
    await mkdir(directory, { recursive: true });
    file = path.join(
      directory,
      await uniqueFilename(
        directory,
        `${date}-${time.replace(":", "")}-${slug}`,
        ".md",
      ),
    );
  }
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  return { path: path.relative(oceanRoot(), file).split(path.sep).join("/") };
}
