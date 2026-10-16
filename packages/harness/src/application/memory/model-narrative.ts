import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { redactRuntimeText } from "@ocean/core/domain/redaction/redaction.js";
import type {
  Session,
  SessionEvent,
} from "@ocean/core/domain/sessions/session.js";
import { oceanEnv, oceanEnvPair } from "@ocean/core/shared/paths.js";

const execFile = promisify(execFileCallback);

export type ModelNarrative = {
  workLog?: string;
  decision?: string;
  problem?: string;
  next?: string;
};

const SYSTEM_PROMPT =
  'You are a terse session summarizer. Read the evidence and reply with ONLY a JSON object, no prose, no markdown fences: {"workLog":"one line, what happened","decision":"one line or omit","problem":"one line or omit","next":"one line or omit"}. Omit a key entirely if the evidence gives nothing for it. Never invent facts not present in the evidence.';

function safeText(value: string, max = 400): string {
  return redactRuntimeText(value).replace(/\s+/g, " ").trim().slice(0, max);
}

/** Cheap, cost-conscious skip: no point paying for a model call on a trivial session. */
export function isTrivialSession(
  events: SessionEvent[],
  changedFiles: string[],
): boolean {
  if (changedFiles.length > 0) return false;
  return !events.some(
    (event) =>
      (event.type === "provider_output" || event.type === "text") &&
      event.data.trim().length > 40,
  );
}

function buildPrompt(input: {
  session: Session;
  events: SessionEvent[];
  changedFiles: string[];
  nextAction?: string;
}): string {
  const objective = input.events.find(
    (event) => event.type === "user_input" || event.type === "resume_requested",
  );
  const outputs = input.events
    .filter(
      (event) =>
        event.type === "provider_output" ||
        event.type === "text" ||
        event.type === "json",
    )
    .map((event) => safeText(event.data, 300))
    .filter(Boolean)
    .slice(0, 6);
  const errors = input.events
    .filter(
      (event) => event.type === "error" || event.type === "provider_blocked",
    )
    .map((event) => safeText(event.data, 300))
    .slice(0, 3);
  const lines = [
    `Objective: ${safeText(objective?.data ?? input.session.title, 200)}`,
    `Changed files: ${input.changedFiles.length ? input.changedFiles.slice(0, 20).join("; ") : "none"}`,
    outputs.length
      ? `Conversation excerpts:\n${outputs.map((line) => `- ${line}`).join("\n")}`
      : "Conversation excerpts: none",
    errors.length
      ? `Errors/blocks:\n${errors.map((line) => `- ${line}`).join("\n")}`
      : "",
    input.nextAction
      ? `Stated next action: ${safeText(input.nextAction, 200)}`
      : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export function parseResult(stdout: string): ModelNarrative | null {
  // --output-format json prints one JSON object, but non-interactive terminal
  // control sequences (e.g. a trailing cursor-show code) can follow it on
  // stdout even when not attached to a TTY — trim to the outermost braces
  // before parsing rather than parsing the whole stream verbatim.
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  let envelope: { result?: unknown };
  try {
    envelope = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof envelope.result !== "string") return null;
  const text = envelope.result
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  const narrative: ModelNarrative = {};
  for (const key of ["workLog", "decision", "problem", "next"] as const) {
    if (typeof value[key] === "string" && value[key].trim())
      narrative[key] = safeText(value[key] as string, 300);
  }
  return Object.keys(narrative).length ? narrative : null;
}

/**
 * Best-effort, cost-conscious human narrative via a cheap headless model call.
 * Returns null on any failure (auth, timeout, parse error) so the caller falls
 * back to the deterministic heuristic in daily-narrative.ts. Never throws.
 *
 * Guarded against recursion: the spawned call carries OCEAN_NARRATIVE_CALL=1,
 * and session-closeout.ts skips calling this again when that flag is already
 * set on the current process (i.e. this IS a narrative-generation session).
 */
export async function generateModelNarrative(input: {
  session: Session;
  events: SessionEvent[];
  changedFiles: string[];
  nextAction?: string;
}): Promise<ModelNarrative | null> {
  // Opt-in only: unset (tests, CI, a fresh install) means no model call — no
  // network, no auth requirement, no cost, fully deterministic by default.
  if (oceanEnv("MODEL_NARRATIVE") !== "1") return null;
  if (oceanEnv("NARRATIVE_CALL") === "1") return null;
  if (isTrivialSession(input.events, input.changedFiles)) return null;

  const prompt = buildPrompt(input);
  try {
    const result = await execFile(
      "claude",
      [
        "-p",
        prompt,
        "--model",
        "haiku",
        "--output-format",
        "json",
        "--system-prompt",
        SYSTEM_PROMPT,
        "--allowedTools",
        "",
        "--disallowedTools",
        "Bash,Edit,Write,Read,Glob,Grep,NotebookEdit,WebFetch,WebSearch",
      ],
      {
        timeout: 30_000,
        maxBuffer: 65_536,
        env: { ...process.env, ...oceanEnvPair("NARRATIVE_CALL", "1") },
      },
    );
    return parseResult(result.stdout);
  } catch {
    return null;
  }
}
