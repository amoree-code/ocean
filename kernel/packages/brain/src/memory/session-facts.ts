import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { MemoryContractError } from "@ocean/core/domain/mcp/memory-contract.js";
import { redactSecrets } from "@ocean/core/domain/redaction/redaction.js";
import { atomicWrite, withFileLock } from "@ocean/core/shared/fs-utils.js";
import { localDate } from "@ocean/core/shared/local-date.js";
import {
  FACT_TYPES,
  type FactType,
  factTarget,
  isFactType,
} from "./fact-routing.js";
import { readAudit, sha256 } from "./memory-audit.js";
import { sessionFactsLedgerFile } from "./memory-paths.js";
import { proposeMemory, writeMemoryRecord } from "./memory-write.js";
import { type Triage, triageTurns } from "./session-triage.js";

// Automatic fact capture at the end of a session and before a compaction (T-313). The industry
// pattern (Zep, Mem0, Supermemory): code around the model runs the memory loop, so a fact the
// user stated is captured whether or not the model remembered to call memory_propose. What this
// module never does: write a record. Every fact becomes a candidate with `source: session:<id>`,
// and such a candidate is never auto-approved (memory-review.ts), so the owner reviews each one.
//
// The model is injected (`complete`): provider execution lives in harness, which brain cannot
// import, and tests pass a recorded answer.

export type FactTurn = { role: "user" | "assistant"; text: string };

// Where a claim comes from (T-329 phase 2): what the user said, what a tool run showed, or
// neither. Each is checked against the turns: a quote that is not found makes the claim
// unverified, and an unverified claim is never filed as knowledge or proposed as memory.
export type Evidence = "user" | "tool" | "unverified";

export const evidenceTag = (evidence: Evidence) => `[${evidence}]`;

// The evidence a session record's list item carries, read back from its leading tag; null for an
// item written before tags existed.
export function itemEvidence(item: string): Evidence | null {
  const tag = /^\[(user|tool|unverified)\]\s*/.exec(item);
  return tag ? (tag[1] as Evidence) : null;
}

export const untagged = (item: string) =>
  item.replace(/^\[(user|tool|unverified)\]\s*/, "");

export type SessionFact = {
  title: string;
  content: string;
  // A verbatim quote from one of the user's turns (source "user") or from a tool result
  // (source "tool"); a fact whose quote is not found there is dropped.
  evidence: string;
  source?: Exclude<Evidence, "unverified">;
  reason: string;
  project?: string;
  // Which row of the routing table the fact belongs to; its target follows from it (T-314).
  type?: FactType;
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

// A short account of the conversation for the day's log (T-314), asked for in the same call as
// the facts so a chat summary costs a few output tokens, never a second model call.
export type SessionDigest = {
  title: string;
  goal: string;
  outcome: string;
  decisions: string[];
  fixes: string[];
  learned: string[];
  next: string[];
};

// A digest's lists grow with the conversation instead of a fixed cap (T-329 phase 2).
const DIGEST_ITEMS = 3;
const DIGEST_ITEMS_LONG = 6;
const LONG_CONVERSATION_CHARS = 12_000;
const DIGEST_ITEM_CHARS = 220;

export function digestItems(turns: FactTurn[]): number {
  const chars = turns.reduce((sum, turn) => sum + turn.text.length, 0);
  return chars >= LONG_CONVERSATION_CHARS ? DIGEST_ITEMS_LONG : DIGEST_ITEMS;
}

const digestPrompt = (items: number) => [
  "Also summarize the whole conversation for the user's daily log, in the digest field. Plain short sentences in English; lists may be empty; never a secret or a [REDACTED] value.",
  `title: what the conversation was about, at most 8 words. goal and outcome: one sentence each. decisions, fixes ("problem → fix"), learned: at most ${items} items each, every item an object {"text","evidence","quote"}. next: at most ${items} plain strings.`,
  'evidence is "user" when the USER said or confirmed it (quote: an exact copy from one USER line), "tool" when a tool result in the conversation shows it (quote: an exact copy from that [tool result: …]), else "unverified" (quote: ""). An assistant claim nobody confirmed and no tool showed is "unverified"; a decision the user did not confirm is not a decision.',
];

export function buildFactsPrompt(
  turns: FactTurn[],
  options: { digest?: boolean; items?: number } = {},
): string {
  const transcript = turns
    .map(
      (turn) => `[${turn.role === "user" ? "USER" : "ASSISTANT"}] ${turn.text}`,
    )
    .join("\n");
  return [
    "You extract durable memory from one conversation between a user and an AI assistant.",
    "Durable means still true and useful in a later, unrelated conversation: the user's identity, role, preferences, standing decisions, project facts, constraints, and corrections to the assistant.",
    "Only extract what the USER stated or explicitly confirmed, or a durable project fact a tool result shows (a version, a path, a setting). Never extract the assistant's suggestions, guesses or plans the user did not confirm.",
    "Never extract temporary state (what is being debugged right now, today's to-do, a file being edited), secrets, credentials, or anything marked [REDACTED] or [PRIVATE_PATH].",
    `Return at most ${MAX_FACTS} facts. Returning none is correct and common.`,
    ...(options.digest ? digestPrompt(options.items ?? DIGEST_ITEMS) : []),
    "Answer with JSON only, no prose and no code fence:",
    `{"facts":[{"title":"short label","content":"the fact as one or two plain sentences","source":"user or tool","evidence":"an exact quote, copied character for character from one USER line (source user) or one [tool result: …] (source tool)","reason":"why it is durable","type":"one of the types below","project":"project name if the fact is about one, else omit"}]${options.digest ? ',"digest":{"title":"","goal":"","outcome":"","decisions":[{"text":"","evidence":"user","quote":""}],"fixes":[],"learned":[],"next":[]}' : ""}}`,
    `type is one of: ${FACT_TYPES.join(", ")}. Use project only for a fact about one project, and then also give its project name; a fact about the user stays a personal type even when it came up in a project.`,
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

// The digest the answer holds, cleaned and bounded; null when there is none or it says nothing.
// Each decision, fix and learned item is checked against the turns and tagged with the evidence
// that held up ([user], [tool] or [unverified]); a bare string is unverified.
export function parseDigest(
  text: string | null,
  turns: FactTurn[] = [],
  items = DIGEST_ITEMS,
): SessionDigest | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      digest?: unknown;
    };
    if (!parsed.digest || typeof parsed.digest !== "object") return null;
    value = parsed.digest as Record<string, unknown>;
  } catch {
    return null;
  }
  const usable = (item: string) =>
    item && !/\[(redacted|private_path)\]/i.test(item);
  const raw = (key: string) =>
    Array.isArray(value[key]) ? (value[key] as unknown[]) : [];
  const list = (key: string) =>
    raw(key)
      .map((item) => redactSecrets(clean(item, DIGEST_ITEM_CHARS)))
      .filter(usable)
      .slice(0, items);
  const claims = (key: string) =>
    raw(key)
      .map((item) => {
        const claim =
          item && typeof item === "object"
            ? (item as Record<string, unknown>)
            : { text: item };
        const text = redactSecrets(clean(claim.text, DIGEST_ITEM_CHARS));
        const evidence = checkedEvidence(
          claim.evidence,
          clean(claim.quote, MAX_EVIDENCE),
          turns,
        );
        return usable(text) ? `${evidenceTag(evidence)} ${text}` : "";
      })
      .filter(Boolean)
      .slice(0, items);
  const digest: SessionDigest = {
    title: redactSecrets(clean(value.title, 80)),
    goal: redactSecrets(clean(value.goal, DIGEST_ITEM_CHARS)),
    outcome: redactSecrets(clean(value.outcome, DIGEST_ITEM_CHARS)),
    decisions: claims("decisions"),
    fixes: claims("fixes"),
    learned: claims("learned"),
    next: list("next"),
  };
  return digest.title || digest.goal ? digest : null;
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
    if (value.source === "tool") fact.source = "tool";
    const project = clean(value.project, 64);
    if (project) fact.project = project;
    if (isFactType(value.type)) fact.type = value.type;
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

// A tool result as desktop-chat.ts writes it: "[tool result: …]" or "[tool error: …]" on a line of
// its own, its body flattened to one line. The line is the result's exact extent, so assistant
// prose after it never counts as something a tool showed.
const RESULT_LINE = /^\[tool (?:result|error): (.*?)\]?$/gm;

function quoteInUser(quote: string, turns: FactTurn[]): boolean {
  return turns.some(
    (turn) => turn.role === "user" && normalize(turn.text).includes(quote),
  );
}

function quoteInTool(quote: string, turns: FactTurn[]): boolean {
  return turns.some(
    (turn) =>
      turn.role === "assistant" &&
      [...turn.text.matchAll(RESULT_LINE)].some((line) =>
        normalize(line[1] ?? "").includes(quote),
      ),
  );
}

function quoteFound(
  source: Evidence,
  quote: string,
  turns: FactTurn[],
): boolean {
  const normalized = normalize(quote);
  if (normalized.length < MIN_EVIDENCE) return false;
  if (/\[(redacted|private_path)\]/.test(normalized)) return false;
  if (source === "user") return quoteInUser(normalized, turns);
  if (source === "tool") return quoteInTool(normalized, turns);
  return false;
}

// What the claimed evidence holds up as: the claim when its quote is found where it says,
// unverified otherwise.
export function checkedEvidence(
  claimed: unknown,
  quote: string,
  turns: FactTurn[],
): Evidence {
  if (claimed !== "user" && claimed !== "tool") return "unverified";
  return quoteFound(claimed, quote, turns) ? claimed : "unverified";
}

// The false-positive guard: a fact counts only when its evidence is really in what the user
// said, or in a tool result for a fact whose source is a tool (after the same redaction the model
// saw). An assistant line, a paraphrase passed off as a quote, or an invented fact has no such
// quote.
export function isGrounded(fact: SessionFact, turns: FactTurn[]): boolean {
  return quoteFound(fact.source ?? "user", fact.evidence, turns);
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
  // The conversation's summary, when it was asked for (digest: true) and given.
  digest?: SessionDigest | null;
  // The free triage before the model; a chat it found trivial had no model call.
  triage?: Triage;
};

const FIRST_LINE_CHARS = 80;

// The one-line record of a chat triage found trivial: its first request, no model involved.
export function trivialDigest(turns: FactTurn[]): SessionDigest | null {
  const first = turns.find((turn) => turn.role === "user");
  const line = first ? redactSecrets(clean(first.text, DIGEST_ITEM_CHARS)) : "";
  if (!line || /\[(redacted|private_path)\]/i.test(line)) return null;
  return {
    title: clean(line, FIRST_LINE_CHARS),
    goal: line,
    outcome: "",
    decisions: [],
    fixes: [],
    learned: [],
    next: [],
  };
}

export async function extractSessionFacts(options: {
  turns: FactTurn[];
  complete: CompleteText;
  budgetChars?: number;
  digest?: boolean;
  // false skips the free triage and always calls the model.
  triage?: boolean;
}): Promise<ExtractionResult> {
  const turns = selectTurns(options.turns, options.budgetChars);
  if (!turns.some((turn) => turn.role === "user"))
    return { facts: [], rejected: [], prompt: "", turns: 0, failed: false };
  const triage = triageTurns(turns);
  if (options.triage !== false && !triage.worth)
    return {
      facts: [],
      rejected: [],
      prompt: "",
      turns: turns.length,
      failed: false,
      triage,
      ...(options.digest ? { digest: trivialDigest(turns) } : {}),
    };
  const items = digestItems(turns);
  const prompt = buildFactsPrompt(turns, { digest: options.digest, items });
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
    triage,
    ...(options.digest ? { digest: parseDigest(answer, turns, items) } : {}),
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

export type CaptureResult = {
  // Filed straight into memory: a new record each, undone with `ocean memory undo <auditId>`.
  filed: { path: string; auditId: string }[];
  // Left for the owner's review: a fact with no home, or one that would change a record.
  proposed: string[];
  skipped: { title: string; reason: string }[];
};

// Each grounded fact (T-329 phase 3) is filed on its own when it routes to a record that does not
// exist yet: the audit keeps it, and undo is a soft delete. A fact that would change an existing
// or similar record, or that has no home, waits as a candidate (proposeMemory's own checks: size,
// secrets). A ledger of content hashes keeps the same fact from being captured twice across
// sessions; within one session the transcript cursor already keeps the same turns from being read
// twice.
export async function captureSessionFacts(options: {
  sessionId: string;
  client: string;
  facts: SessionFact[];
}): Promise<CaptureResult> {
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
}): Promise<CaptureResult> {
  const ledger = await readLedger();
  const result: CaptureResult = { filed: [], proposed: [], skipped: [] };
  for (const fact of options.facts) {
    const key = factKey(fact);
    if (ledger[key]) {
      result.skipped.push({
        title: fact.title,
        reason: `already proposed as ${ledger[key]}`,
      });
      continue;
    }
    const content = `# ${fact.title}\n\n${fact.content}\n\n> ${fact.evidence}\n`;
    const source = `${SESSION_FACTS_SOURCE_PREFIX}${options.sessionId}`;
    const target = await factTarget(fact);
    if (target) {
      const written = await fileNew(target, content, source);
      if (written) {
        ledger[key] = written.path;
        result.filed.push(written);
        continue;
      }
    }
    try {
      const { candidate } = await proposeMemory({
        content,
        origin: "inferred",
        source,
        reason: fact.reason || "stated by the user in a session",
        target,
        meta: {
          kind: "fact",
          client: options.client,
          evidence: fact.source ?? "user",
          ...(fact.type ? { type: fact.type } : {}),
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
  if (result.proposed.length || result.filed.length) await writeLedger(ledger);
  return result;
}

export type FiledFact = { path: string; auditId: string; at: string };

// What sessions filed on their own on one local date and is still there (not undone or deleted
// since): the day's "Filed" list, each with its undo.
export async function filedFromSessions(
  date = localDate(),
): Promise<FiledFact[]> {
  const entries = await readAudit();
  const filed: FiledFact[] = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.action !== "create" || !isSessionFactSource(entry.source))
      continue;
    if (localDate(new Date(entry.ts)) !== date) continue;
    const removed = entries
      .slice(index + 1)
      .some((later) => later.path === entry.path && later.action === "delete");
    if (!removed)
      filed.push({ path: entry.path, auditId: entry.id, at: entry.ts });
  }
  return filed;
}

// A new record, or null when the path or a similar record exists (or the write is refused):
// changing a record the owner has is left to his review.
async function fileNew(
  target: string,
  content: string,
  source: string,
): Promise<{ path: string; auditId: string } | null> {
  try {
    const written = await writeMemoryRecord({
      path: target,
      content,
      mode: "create",
      source,
      provenance: { origin: "inferred" },
    });
    return { path: written.path, auditId: written.auditId };
  } catch (error) {
    if (error instanceof MemoryContractError) return null;
    throw error;
  }
}
