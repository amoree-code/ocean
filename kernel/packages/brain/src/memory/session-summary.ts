import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactRuntimeText } from "@ocean/core/domain/redaction/redaction.js";
import type {
  Session,
  SessionEvent,
} from "@ocean/core/domain/sessions/session.js";
import { safeJsonParse } from "@ocean/core/shared/fs-utils.js";
import { localDate, localMoment } from "@ocean/core/shared/local-date.js";
import { oceanPath, oceanRoot, SYSTEM_DIR } from "@ocean/core/shared/paths.js";

const maxSummaryBytes = 12_000;

export type SessionSummaryResult = {
  summaryPath: string;
  summaryHash: string;
  summaryBytes: number;
};

function safeText(value: string, max = 800): string {
  return redactRuntimeText(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function eventText(
  events: SessionEvent[],
  types: string[],
  maxItems = 4,
): string[] {
  return events
    .filter((event) => types.includes(event.type))
    .map((event) => safeText(event.data))
    .filter(Boolean)
    .slice(0, maxItems);
}

function lastEvent(
  events: SessionEvent[],
  type: string,
): SessionEvent | undefined {
  return [...events].reverse().find((event) => event.type === type);
}

function renderSessionSummary(input: {
  session: Session;
  events: SessionEvent[];
  changedFiles?: string[];
  exitCode?: number;
  nextAction?: string;
}): string {
  const { session, events } = input;
  const request =
    eventText(events, ["user_input", "resume_requested"], 1)[0] ??
    session.title;
  const outputs = eventText(events, ["provider_output", "text", "json"], 4);
  const errors = eventText(events, ["error", "provider_blocked"], 4);
  const evidence = events
    .filter((event) => event.type === "evidence")
    .map((event) => safeJsonParse(event.data))
    .filter((value): value is Record<string, unknown> => value !== null);
  const proven = evidence
    .filter((value) => value.result === "proven")
    .map((value) => String(value.criterion ?? "verified result"));
  const notProven = evidence
    .filter((value) => value.result !== "proven")
    .map((value) => String(value.criterion ?? value.result ?? "not proven"));
  const processExit = lastEvent(events, "process_exit");
  const exit =
    input.exitCode ??
    (processExit ? safeJsonParse(processExit.data)?.exitCode : undefined);
  const status =
    session.status === "completed" && exit === 0 ? "completed" : session.status;
  const nextAction =
    input.nextAction ??
    session.nextAction ??
    "Review the summary and verify the next action.";
  const lines = [
    "# Session Summary",
    "",
    `- Session: ${session.sessionId}`,
    `- Provider: ${session.provider}`,
    `- Task: ${session.taskId ?? "none"}`,
    `- Profile: ${session.profile}`,
    `- Status: ${status}`,
    `- Working directory: ${safeText(session.workingDirectory, 240)}`,
    "",
    "## Objective",
    "",
    request || "No user objective was captured.",
    "",
    "## What happened",
    "",
    ...(outputs.length
      ? outputs.map((value) => `- ${value}`)
      : ["- No provider output was captured."]),
    "",
    "## Files changed",
    "",
    ...(input.changedFiles?.length
      ? input.changedFiles.map((value) => `- ${safeText(value, 240)}`)
      : ["- No changed-file evidence was recorded."]),
    "",
    "## Verification",
    "",
    ...(proven.length
      ? proven.map((value) => `- PROVEN: ${safeText(value)}`)
      : ["- No independently proven verification recorded."]),
    ...(notProven.length
      ? notProven.map((value) => `- NOT PROVEN: ${safeText(value)}`)
      : []),
    "",
    "## Problems and limitations",
    "",
    ...(errors.length
      ? errors.map((value) => `- ${value}`)
      : ["- None recorded."]),
    "",
    "## Next action",
    "",
    safeText(nextAction, 800),
    "",
    "## Retrieval",
    "",
    `- Detailed bounded events: ocean session events ${session.sessionId}`,
    `- Context bytes: ${session.contextBytes}`,
  ];
  let content = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(content) > maxSummaryBytes)
    content = `${content.slice(0, maxSummaryBytes - 120)}\n\n- Summary truncated; detailed bounded events remain available by session id.\n`;
  return content;
}

export async function writeSessionSummary(input: {
  session: Session;
  events: SessionEvent[];
  changedFiles?: string[];
  exitCode?: number;
  nextAction?: string;
}): Promise<SessionSummaryResult> {
  const date = localDate(localMoment(input.session.createdAt));
  const directory = oceanPath(SYSTEM_DIR, "sessions", "summaries");
  const file = path.join(directory, `${date}-${input.session.sessionId}.md`);
  await mkdir(directory, { recursive: true });
  const content = renderSessionSummary(input);
  await writeFile(file, content, "utf8");
  return {
    summaryPath: path.relative(oceanRoot(), file).split(path.sep).join("/"),
    summaryHash: createHash("sha256").update(content).digest("hex"),
    summaryBytes: Buffer.byteLength(content),
  };
}
