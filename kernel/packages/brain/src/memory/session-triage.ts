import type { FactTurn } from "./session-facts.js";

// Free, deterministic triage before any model call (T-329 phase 2). A chat with nothing durable
// in it — a greeting, one short question, a quick lookup — costs no model call: it gets a
// one-line record and nothing else. Anything that might hold a fact, a decision or real work goes
// on to extraction. A wrong "worth it" costs one call; a wrong "trivial" loses what was said, so
// every rule leans towards extraction.

// What the user says when they state a fact about themselves, decide, prefer or correct:
// English and Iraqi Arabic.
const SIGNAL =
  /\b(let'?s|i am|i'm|i use|i work|i live|i deploy|i prefer|my|we|our|always|never|every|prefer|don'?t|do not|from now on|remember|decid\w*|instead|wrong|correct\w*|should|must|rule|policy)\b|دائما|دايما|ابد[اً]?|لا تسوي|لا تكتب|خلي|احفظ|تذكر|قررت|غلط|صحح|افضل|أفضل|كل مرة/i;

// A tool call as desktop-chat.ts writes it ("[tool name: …]"), not its result.
const TOOL_CALL = /\[tool (?!result:|error:)[^\]:]+[\]:]/g;
// A file path with an extension: work that touched the project.
const FILE_PATH = /(?:^|[\s(`'"])(?:[\w.-]+\/)+[\w.-]+\.[a-z]{1,6}\b/gi;

const MIN_USER_TURNS = 4;
const MIN_USER_CHARS = 800;
const MIN_TOOL_CALLS = 3;
// A long answer is real work even where the transcript keeps no tool steps (Claude Code, Codex).
const MIN_ASSISTANT_CHARS = 2_000;

export type Triage = {
  worth: boolean;
  // Why it is worth a model call; empty when it is not.
  reasons: string[];
  userTurns: number;
  userChars: number;
  toolCalls: number;
  files: number;
};

export function triageTurns(turns: FactTurn[]): Triage {
  const user = turns.filter((turn) => turn.role === "user");
  const assistant = turns.filter((turn) => turn.role === "assistant");
  const userText = user.map((turn) => turn.text).join("\n");
  const allText = turns.map((turn) => turn.text).join("\n");
  const toolCalls = assistant.reduce(
    (count, turn) => count + (turn.text.match(TOOL_CALL)?.length ?? 0),
    0,
  );
  const files = new Set(allText.match(FILE_PATH)?.map((m) => m.trim()) ?? [])
    .size;
  const triage: Triage = {
    worth: false,
    reasons: [],
    userTurns: user.length,
    userChars: userText.length,
    toolCalls,
    files,
  };
  if (!user.length) return triage;
  if (SIGNAL.test(userText)) triage.reasons.push("stated or decided");
  if (user.length >= MIN_USER_TURNS) triage.reasons.push("long exchange");
  if (userText.length >= MIN_USER_CHARS) triage.reasons.push("long request");
  if (toolCalls >= MIN_TOOL_CALLS) triage.reasons.push("tool work");
  const answered = assistant.reduce((sum, turn) => sum + turn.text.length, 0);
  if (answered >= MIN_ASSISTANT_CHARS) triage.reasons.push("long answer");
  if (files) triage.reasons.push("files touched");
  triage.worth = triage.reasons.length > 0;
  return triage;
}
