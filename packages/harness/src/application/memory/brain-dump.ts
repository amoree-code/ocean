import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactRuntimeText } from "@ocean/core/domain/redaction/redaction.js";
import type {
  Session,
  SessionEvent,
} from "@ocean/core/domain/sessions/session.js";
import { INBOX_DIR, oceanPath, oceanRoot } from "@ocean/core/shared/paths.js";
import { findGitRoot } from "@ocean/core/shared/project-resolution.js";
import type { TaskObservation } from "@ocean/market/skills/task-observer.js";
import type { ModelNarrative } from "./model-narrative.js";

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
 * One human-readable Markdown file per session under brain/00-inbox/brain-dump/,
 * separate from the machine-oriented kernel/bridge/sessions/summaries/ dump. Prefers
 * the cheap model narrative (see model-narrative.ts) and falls back to the
 * same deterministic heuristics as daily-narrative.ts when it is unavailable.
 * When task-observer.ts already found signals for this session (corrections,
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
  observations?: TaskObservation[];
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

  const time =
    session.createdAt.slice(11, 16) || new Date().toISOString().slice(11, 16);
  const date =
    session.createdAt.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const project =
    path.basename(session.workingDirectory) || session.workingDirectory;
  const status =
    session.status === "completed" && (input.exitCode ?? 0) === 0
      ? "completed"
      : "failed";
  const title = isGenericContent(workLog) ? project : workLog;

  const lines = [
    `# ${title}`,
    "",
    `- Date: ${date} ${time}`,
    `- Provider: ${session.provider}`,
    `- Project: ${project}`,
    `- Status: ${status}`,
    "",
    "## What happened",
    "",
    workLog || "No objective was captured.",
    ...(decision ? ["", "## Decision", "", decision] : []),
    ...(problem ? ["", "## Problem", "", problem] : []),
    ...(changedFiles.length
      ? [
          "",
          "## Files changed",
          "",
          ...changedFiles.map((f) => `- ${safeText(f, 240)}`),
        ]
      : []),
    ...(hasNextAction
      ? ["", "## Next", "", safeText(nextAction as string, 300)]
      : []),
    ...(observations?.length
      ? [
          "",
          "## Signals",
          "",
          ...observations.map(
            (o) =>
              `- [${o.signalType}] ${safeText(o.summary, 300)} (confidence ${o.confidence})`,
          ),
        ]
      : []),
    "",
    "---",
    "",
    `Session id: ${session.sessionId} · Raw events: \`ocean session events ${session.sessionId}\``,
  ];

  const directory = oceanPath(INBOX_DIR, "brain-dump");
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
