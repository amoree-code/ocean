import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { MemoryContractError } from "@ocean/core/domain/mcp/memory-contract.js";
import { redactSecrets } from "@ocean/core/domain/redaction/redaction.js";
import { atomicWrite, withFileLock } from "@ocean/core/shared/fs-utils.js";
import { sha256 } from "./memory-audit.js";
import { sessionFactsLedgerFile } from "./memory-paths.js";
import { proposeMemory } from "./memory-write.js";

// Automatic fact capture at the end of a session and before a compaction (T-313). The industry
// pattern (Zep, Mem0, Supermemory): code around the model runs the memory loop, so a fact the
// user stated is captured whether or not the model remembered to call memory_propose. What this
// module never does: write a record. Every fact becomes a candidate with `source: session:<id>`,
// and such a candidate is never auto-approved (memory-review.ts), so the owner reviews each one.
//
// The model is injected (`complete`): provider execution lives in harness, which brain cannot
// import, and tests pass a recorded answer.

export type FactTurn = { role: "user" | "assistant"; text: string };

export type SessionFact = {
  title: string;
  content: string;
  // A verbatim quote from one of the user's turns; a fact whose quote is not found is dropped.
  evidence: string;
  reason: string;
  project?: string;
};

// One model call: prompt in, the model's final text out; null when the call failed.
export type CompleteText = (prompt: string) => Promise<string | null>;

export const SESSION_FACTS_SOURCE_PREFIX = "session:";

export function isSessionFactSource(source: string | undefined): boolean {
  return (
    typeof source === "string" && source.startsWith(SESSION_FACTS_SOURCE_PREFIX)
  );
}

// About 6k tokens of transcript per call; the user's own words get most of it.
export const DEFAULT_FACTS_BUDGET_CHARS = 24_000;
const USER_SHARE = 0.7;
const MAX_TURN_CHARS = 4_000;
export const MAX_FACTS = 5;
const MAX_TITLE = 100;
const MAX_CONTENT = 1_200;
const MAX_EVIDENCE = 300;
const MIN_EVIDENCE = 8;

// Secrets and private paths are replaced before any text reaches a model (the candidate check
// runs again on the output). Turns are then chosen within the budget: the newest user turns
// first, up to USER_SHARE of it, then the newest assistant turns in what is left, and the chosen
// ones are put back in conversation order.
export function selectTurns(
  turns: FactTurn[],
  budgetChars = DEFAULT_FACTS_BUDGET_CHARS,
): FactTurn[] {
  const redacted = turns
    .map((turn, index) => ({
      index,
      role: turn.role,
      text: redactSecrets(turn.text.replace(/\s+/g, " ").trim()).slice(
        0,
        MAX_TURN_CHARS,
      ),
    }))
    .filter((turn) => turn.text);
  const chosen = new Set<number>();
  let used = 0;
  const take = (role: FactTurn["role"], limit: number) => {
    for (let i = redacted.length - 1; i >= 0; i--) {
      const turn = redacted[i];
      if (turn.role !== role || chosen.has(turn.index)) continue;
      if (used + turn.text.length > limit) continue;
      chosen.add(turn.index);
      used += turn.text.length;
    }
  };
  take("user", Math.floor(budgetChars * USER_SHARE));
  take("assistant", budgetChars);
  // Left-over room from the assistant pass goes back to older user turns.
  take("user", budgetChars);
  return redacted
    .filter((turn) => chosen.has(turn.index))
    .map(({ role, text }) => ({ role, text }));
}

export function buildFactsPrompt(turns: FactTurn[]): string {
  const transcript = turns
    .map(
      (turn) => `[${turn.role === "user" ? "USER" : "ASSISTANT"}] ${turn.text}`,
    )
    .join("\n");
  return [
    "You extract durable memory from one conversation between a user and an AI assistant.",
    "Durable means still true and useful in a later, unrelated conversation: the user's identity, role, preferences, standing decisions, project facts, constraints, and corrections to the assistant.",
    "Only extract what the USER stated or explicitly confirmed. Never extract the assistant's suggestions, guesses or plans the user did not confirm.",
    "Never extract temporary state (what is being debugged right now, today's to-do, a file being edited), secrets, credentials, or anything marked [REDACTED] or [PRIVATE_PATH].",
    `Return at most ${MAX_FACTS} facts. Returning none is correct and common.`,
    "Answer with JSON only, no prose and no code fence:",
    '{"facts":[{"title":"short label","content":"the fact as one or two plain sentences","evidence":"an exact quote, copied character for character from one USER line","reason":"why it is durable","project":"project name if the fact is about one, else omit"}]}',
    'Answer {"facts":[]} when nothing qualifies.',
    "",
    "Conversation:",
    transcript,
  ].join("\n");
}

const clean = (value: unknown, max: number): string =>
  typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, max)
    : "";

// The model's answer → well-formed facts. Anything else (prose, a fence around the JSON, missing
// fields) yields what can be read and drops the rest; never throws.
// The `facts` list the answer holds, or null when the answer is no such JSON at all (a failed
// call, prose, a refusal): then the turns are read again by a later run.
function factsList(text: string | null): unknown[] | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  return parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { facts?: unknown }).facts)
    ? (parsed as { facts: unknown[] }).facts
    : null;
}

export function parseFacts(text: string | null): SessionFact[] {
  const list = factsList(text) ?? [];
  const facts: SessionFact[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    const fact: SessionFact = {
      title: clean(value.title, MAX_TITLE),
      content: clean(value.content, MAX_CONTENT),
      evidence: clean(value.evidence, MAX_EVIDENCE),
      reason: clean(value.reason, 300),
    };
    const project = clean(value.project, 64);
    if (project) fact.project = project;
    if (fact.title && fact.content && fact.evidence) facts.push(fact);
    if (facts.length === MAX_FACTS) break;
  }
  return facts;
}

const normalize = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[‘’“”"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

// The false-positive guard: a fact counts only when its evidence is really in what the user
// said (after the same redaction the model saw). An assistant line, a paraphrase passed off as a
// quote, or an invented fact has no such quote.
export function isGrounded(fact: SessionFact, turns: FactTurn[]): boolean {
  const evidence = normalize(fact.evidence);
  if (evidence.length < MIN_EVIDENCE) return false;
  if (/\[(redacted|private_path)\]/.test(evidence)) return false;
  return turns.some(
    (turn) => turn.role === "user" && normalize(turn.text).includes(evidence),
  );
}

export type ExtractionResult = {
  facts: SessionFact[];
  // Facts the model gave that failed the evidence check, with the reason.
  rejected: { title: string; reason: string }[];
  // What was sent, for tests and the eval: proof that no secret left the machine.
  prompt: string;
  turns: number;
  // The model gave no readable answer; nothing was learned from these turns.
  failed: boolean;
};

export async function extractSessionFacts(options: {
  turns: FactTurn[];
  complete: CompleteText;
  budgetChars?: number;
}): Promise<ExtractionResult> {
  const turns = selectTurns(options.turns, options.budgetChars);
  if (!turns.some((turn) => turn.role === "user"))
    return { facts: [], rejected: [], prompt: "", turns: 0, failed: false };
  const prompt = buildFactsPrompt(turns);
  let answer: string | null = null;
  try {
    answer = await options.complete(prompt);
  } catch {
    answer = null;
  }
  const facts: SessionFact[] = [];
  const rejected: ExtractionResult["rejected"] = [];
  for (const fact of parseFacts(answer)) {
    if (isGrounded(fact, turns)) facts.push(fact);
    else
      rejected.push({
        title: fact.title,
        reason: "evidence not found in a user turn",
      });
  }
  return {
    facts,
    rejected,
    prompt,
    turns: turns.length,
    failed: factsList(answer) === null,
  };
}

type Ledger = Record<string, string>;

const factKey = (fact: SessionFact) => `f:${sha256(normalize(fact.content))}`;

async function readLedger(): Promise<Ledger> {
  try {
    return JSON.parse(
      await readFile(sessionFactsLedgerFile(), "utf8"),
    ) as Ledger;
  } catch {
    return {};
  }
}

async function writeLedger(ledger: Ledger): Promise<void> {
  const file = sessionFactsLedgerFile();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWrite(file, `${JSON.stringify(ledger, null, 2)}\n`, 0o600);
}

export type ProposeResult = {
  proposed: string[];
  skipped: { title: string; reason: string }[];
};

// Each fact → one candidate, through proposeMemory's own checks (size, secrets). A ledger of
// content hashes keeps the same fact from being proposed twice across sessions; within one
// session the transcript cursor already keeps the same turns from being read twice.
export async function proposeSessionFacts(options: {
  sessionId: string;
  client: string;
  facts: SessionFact[];
}): Promise<ProposeResult> {
  // Two sessions ending together read and write the same ledger.
  await mkdir(path.dirname(sessionFactsLedgerFile()), {
    recursive: true,
    mode: 0o700,
  });
  return withFileLock(sessionFactsLedgerFile(), () => proposeLocked(options));
}

async function proposeLocked(options: {
  sessionId: string;
  client: string;
  facts: SessionFact[];
}): Promise<ProposeResult> {
  const ledger = await readLedger();
  const result: ProposeResult = { proposed: [], skipped: [] };
  for (const fact of options.facts) {
    const key = factKey(fact);
    if (ledger[key]) {
      result.skipped.push({
        title: fact.title,
        reason: `already proposed as ${ledger[key]}`,
      });
      continue;
    }
    try {
      const { candidate } = await proposeMemory({
        content: `# ${fact.title}\n\n${fact.content}\n\n> ${fact.evidence}\n`,
        origin: "inferred",
        source: `${SESSION_FACTS_SOURCE_PREFIX}${options.sessionId}`,
        reason: fact.reason || "stated by the user in a session",
        meta: {
          kind: "fact",
          client: options.client,
          ...(fact.project ? { project: fact.project } : {}),
        },
      });
      ledger[key] = candidate;
      result.proposed.push(candidate);
    } catch (error) {
      if (!(error instanceof MemoryContractError)) throw error;
      result.skipped.push({
        title: fact.title,
        reason: `${error.code}: ${error.message}`,
      });
    }
  }
  if (result.proposed.length) await writeLedger(ledger);
  return result;
}
