import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { redactRuntimeText } from "@ocean/core/domain/redaction/redaction.js";
import type {
  Session,
  SessionEvent,
} from "@ocean/core/domain/sessions/session.js";
import { atomicWrite, withFileLock } from "../../fs-utils.js";
import { DAILY_DIR, oceanPath } from "../../paths.js";
import { findGitRoot } from "../../shared/project-resolution.js";
import type { TaskObservation } from "../skills/task-observer.js";
import type { ModelNarrative } from "./model-narrative.js";

const dailyTemplate = (date: string): string =>
  `# Daily — ${date}\n\n## Focus\n\n## Work log\n\n## Decisions\n\n## Problems\n\n## Next\n\n## Observations\n`;

// The literal fallback title stamped on a session with no explicit title
// (see run request construction) — never meaningful content on its own.
const GENERIC_TITLE = /^claude session$/i;

function safeText(value: string, max = 240): string {
  return redactRuntimeText(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function isGenericContent(text: string | null | undefined): boolean {
  const trimmed = (text ?? "").trim();
  return trimmed.length === 0 || GENERIC_TITLE.test(trimmed);
}

function insertUnderHeading(
  content: string,
  heading: string,
  line: string,
): string {
  const marker = `${heading}\n`;
  const index = content.indexOf(marker);
  if (index < 0) return `${content.trimEnd()}\n\n${heading}\n${line}\n`;
  const insertAt = index + marker.length;
  return `${content.slice(0, insertAt)}${line}\n${content.slice(insertAt)}`;
}

// Read-modify-write of today's daily file. Two sessions closing out at once would otherwise
// each write back their own copy and drop the other's lines (T-257), so it runs under the
// file lock and lands atomically.
async function updateDailyFile(
  update: (content: string) => string,
): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const directory = oceanPath(DAILY_DIR);
  const file = path.join(directory, `${date}.md`);
  await mkdir(directory, { recursive: true });
  await withFileLock(file, async () => {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch (error) {
      // Only a missing file starts from the template: any other read failure must not
      // replace a real day's log with an empty one.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      content = dailyTemplate(date);
    }
    // A symlinked daily file keeps its link: the write goes to the real file.
    const target = await realpath(file).catch(() => file);
    await atomicWrite(target, update(content));
  });
}

/**
 * Human-readable narrative entry appended to today's
 * brain/01-daily/YYYY-MM-DD.md at session closeout. A field from `narrative`
 * (produced by a cheap model call — see model-narrative.ts) is used verbatim
 * when present; any field it omits (including when the model call was
 * skipped or failed entirely) falls back to the deterministic heuristic
 * below, so this never depends on the model call succeeding.
 */
export async function appendDailyNarrative(input: {
  session: Session;
  events: SessionEvent[];
  exitCode?: number;
  nextAction?: string;
  narrative?: ModelNarrative | null;
}): Promise<void> {
  const { session, events, narrative } = input;
  const inserts: Array<[heading: string, line: string]> = [];
  const time = new Date().toISOString().slice(11, 16);
  const project =
    path.basename(session.workingDirectory) || session.workingDirectory;
  const status =
    session.status === "completed" && (input.exitCode ?? 0) === 0
      ? "completed"
      : "failed";

  const workLog =
    narrative?.workLog ??
    (() => {
      const objectiveEvent = events.find(
        (event) =>
          event.type === "user_input" || event.type === "resume_requested",
      );
      return safeText(objectiveEvent?.data ?? session.title, 160);
    })();

  // Skip the doubly-useless case: no real content beyond the generic
  // placeholder title, AND no real project (root/home session, no git repo)
  // to give the entry any meaning. A generic title in a real project, or
  // real content with no project, still gets logged.
  const hasRealProject = findGitRoot(session.workingDirectory) !== null;
  const skipWorkLog = isGenericContent(workLog) && !hasRealProject;
  if (!skipWorkLog) {
    inserts.push([
      "## Work log",
      `- ${time} ${session.provider} session in ${project}: ${workLog} — ${status}`,
    ]);
  }

  const decisionLine =
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
  if (decisionLine) inserts.push(["## Decisions", `- ${decisionLine}`]);

  const problemLine =
    narrative?.problem ??
    events
      .filter(
        (event) => event.type === "error" || event.type === "provider_blocked",
      )
      .map((event) => safeText(event.data, 500))[0];
  if (problemLine) inserts.push(["## Problems", `- ${problemLine}`]);

  const nextAction = narrative?.next ?? input.nextAction ?? session.nextAction;
  if (
    nextAction &&
    nextAction !== "Review the summary and verify the next action."
  ) {
    inserts.push(["## Next", `- [${project}] ${safeText(nextAction, 240)}`]);
  }

  await updateDailyFile((content) =>
    inserts.reduce(
      (next, [heading, line]) => insertUnderHeading(next, heading, line),
      content,
    ),
  );
}

/**
 * Appends newly detected observations (corrections, repeated procedures,
 * explicit decisions, proven verifications — see task-observer.ts) to
 * today's brain/01-daily/YYYY-MM-DD.md, so they surface next to the
 * session narrative instead of sitting only in system/skills/observations.json.
 */
export async function appendObservations(
  session: Session,
  observations: TaskObservation[],
): Promise<void> {
  if (!observations.length) return;
  const project =
    path.basename(session.workingDirectory) || session.workingDirectory;
  await updateDailyFile((content) =>
    observations.reduce(
      (next, observation) =>
        insertUnderHeading(
          next,
          "## Observations",
          `- [${observation.signalType}] ${safeText(observation.summary, 300)} _(${project}, confidence ${observation.confidence})_`,
        ),
      content,
    ),
  );
}
