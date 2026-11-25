import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeDigestRecord } from "@ocean/brain/memory/brain-dump.js";
import { projectScope } from "@ocean/brain/memory/fact-routing.js";
import { sessionFactsEnabled } from "@ocean/brain/memory/memory-audit.js";
import {
  type CompleteText,
  captureSessionFacts,
  extractSessionFacts,
  type FactTurn,
} from "@ocean/brain/memory/session-facts.js";
import {
  ActivityTally,
  type SessionActivity,
} from "@ocean/core/domain/sessions/session-metadata.js";
import { atomicWrite, withFileLock } from "@ocean/core/shared/fs-utils.js";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import {
  bindConversation,
  conversationProjectDecision,
} from "@ocean/core/shared/project-resolution.js";

// Fact capture from Claude Desktop's plain chat (T-315). Desktop has no hooks, so a run reads
// the conversations the app keeps locally (the reader is injected: it lives in harness) and
// sends the new turns of each conversation that has gone quiet to the same extraction T-313
// uses. A per-conversation cursor — the creation time of the newest message already claimed,
// which the app's store and the official export both carry — makes every turn read once,
// whichever source it came from: a run claims (cursor, newest] under a short lock, calls the
// model unlocked,
// and hands the turns back if the model gave no answer. Candidates carry
// `source: session:desktop:<uuid>`, so they are never auto-approved. No message text is ever
// written outside the candidates, the session record and the raw transcript (T-329): the state
// file and the run report hold ids, times and counts only.
//
// A conversation is read once it is closed (T-329), not every time it pauses: Desktop has no
// session end, so "closed" is quiet for DEFAULT_CLOSE_MS, or quiet for DEFAULT_QUIET_MS while a
// newer conversation has started since. One pass then sees the whole conversation, instead of
// summing quarter-hour stretches whose title stuck to the first one.

export const DESKTOP_CLIENT = "claude-desktop";
export const DEFAULT_QUIET_MS = 10 * 60 * 1000;
export const DEFAULT_CLOSE_MS = 2 * 60 * 60 * 1000;

// The conversation as read, kept whole so a later pass (or a better model) can read it again
// without the app still holding it. Local only, owner-readable, rewritten on each pass.
export function desktopTranscriptFile(uuid: string): string {
  return oceanPath(
    SYSTEM_DIR,
    "state",
    "transcripts",
    DESKTOP_CLIENT,
    `${uuid.replace(/[^\w-]/g, "_")}.jsonl`,
  );
}

// Written when the kept copy is missing or ends before the conversation does, so a
// conversation read before transcripts were kept gets one too.
async function keepTranscript(conversation: DesktopChat): Promise<void> {
  const file = desktopTranscriptFile(conversation.uuid);
  const kept = conversation.messages.filter(
    (message) => message.createdAt && message.text.trim(),
  );
  const last = kept.at(-1)?.createdAt;
  if (!last) return;
  try {
    const tail = (await readFile(file, "utf8")).trimEnd().split("\n").at(-1);
    if (tail && JSON.parse(tail).at === last) return;
  } catch {
    // no copy yet, or unreadable: write it
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lines = kept.map((message) =>
    JSON.stringify({
      at: message.createdAt,
      role: message.sender === "human" ? "user" : "assistant",
      text: message.text,
    }),
  );
  await atomicWrite(file, `${lines.join("\n")}\n`, 0o600);
}

export type DesktopChatMessage = {
  // ISO time; a message without one is never read.
  createdAt: string;
  sender: "human" | "assistant";
  text: string;
};

export type DesktopChat = {
  uuid: string;
  updatedAt: string;
  messages: DesktopChatMessage[];
};

export type DesktopChatSource = () => Promise<
  { status: "absent" } | { status: "ok"; conversations: DesktopChat[] }
>;

// `from` and `to` are message creation times; "" is the start of the conversation.
type Claim = { from: string; to: string; at: string };
type State = { conversations: Record<string, Claim> };

export function desktopFactsStateFile(): string {
  return oceanPath(SYSTEM_DIR, "state", "memory", "desktop", "cursors.json");
}

// The last run's outcome, for `ocean doctor`: status, counts and an error code, never text.
export function desktopFactsLastRunFile(): string {
  return oceanPath(SYSTEM_DIR, "state", "memory", "desktop", "last-run.json");
}

export type DesktopLastRun = {
  at: string;
  status: string;
  conversations?: number;
  captured?: number;
  candidates?: number;
  filed?: number;
  code?: string;
  reason?: string;
};

export async function recordDesktopRun(run: DesktopLastRun): Promise<void> {
  await mkdir(path.dirname(desktopFactsLastRunFile()), {
    recursive: true,
    mode: 0o700,
  });
  await atomicWrite(
    desktopFactsLastRunFile(),
    `${JSON.stringify(run, null, 2)}\n`,
    0o600,
  );
}

async function readState(): Promise<State> {
  try {
    const parsed = JSON.parse(await readFile(desktopFactsStateFile(), "utf8"));
    if (parsed && typeof parsed.conversations === "object") {
      // Only claims in the current shape count; any other is read from the start.
      for (const [uuid, claim] of Object.entries(parsed.conversations))
        if (typeof (claim as Claim)?.to !== "string")
          delete parsed.conversations[uuid];
      return parsed as State;
    }
  } catch {
    // no state yet, or unreadable: start from the beginning of each conversation
  }
  return { conversations: {} };
}

async function writeState(state: State): Promise<void> {
  await atomicWrite(
    desktopFactsStateFile(),
    `${JSON.stringify(state, null, 2)}\n`,
    0o600,
  );
}

async function locked<T>(run: (state: State) => Promise<T>): Promise<T> {
  await mkdir(path.dirname(desktopFactsStateFile()), {
    recursive: true,
    mode: 0o700,
  });
  return withFileLock(desktopFactsStateFile(), async () =>
    run(await readState()),
  );
}

export type DesktopConversationRun = {
  uuid: string;
  status: "done" | "failed" | "no-user-text" | "no-provider";
  from: string;
  to: string;
  // The session record written from the conversation's digest (T-314).
  record?: string;
  // Records filed on their own (T-329 phase 3); candidates wait for the owner's review.
  filed?: string[];
  candidates?: string[];
  // Free triage found nothing worth a model call: a one-line record only (T-329 phase 2).
  trivial?: boolean;
  // These turns were extracted before; no model call (T-335).
  repeat?: boolean;
  // Project facts with no known project, kept in 00-inbox/unrouted/ (T-335).
  unrouted?: string[];
  // The project the record was filed under (T-333); absent when none was decided.
  project?: string;
  rejected?: number;
  skipped?: number;
};

export type DesktopFactsRun =
  | { status: "off" | "absent" }
  | {
      status: "done";
      conversations: number;
      waiting: number;
      upToDate: number;
      runs: DesktopConversationRun[];
    };

const toTurn = (message: DesktopChatMessage): FactTurn => ({
  role: message.sender === "human" ? "user" : "assistant",
  text: message.text,
});

export async function runDesktopFacts(options: {
  read: DesktopChatSource;
  complete: CompleteText | null;
  now?: Date;
  // One window for every conversation, in place of the quiet/close pair (`--quiet`, exports).
  quietMs?: number;
  closeMs?: number;
  since?: Date;
  // Only the most recently updated conversation, read now (`ocean_session_save`).
  latest?: boolean;
  // With `latest`: bind that conversation to this project first (T-333) — an explicit choice
  // wins over the Claude project the chat sits in.
  project?: string;
  enabled?: () => Promise<boolean>;
}): Promise<DesktopFactsRun> {
  if (!(await (options.enabled ?? sessionFactsEnabled)()))
    return { status: "off" };
  const read = await options.read();
  if (read.status === "absent") return { status: "absent" };
  const now = (options.now ?? new Date()).getTime();
  const quietMs = options.latest ? 0 : (options.quietMs ?? DEFAULT_QUIET_MS);
  const closeMs = options.latest
    ? 0
    : (options.closeMs ?? options.quietMs ?? DEFAULT_CLOSE_MS);
  const newest = read.conversations.reduce(
    (max, c) => Math.max(max, Date.parse(c.updatedAt) || 0),
    0,
  );
  const conversations = options.latest
    ? read.conversations
        .filter((c) => (Date.parse(c.updatedAt) || 0) === newest)
        .slice(0, 1)
    : read.conversations;
  if (options.project) {
    if (!options.latest)
      throw new Error("a project binds only the latest chat");
    for (const conversation of conversations)
      await bindConversation(conversation.uuid, options.project);
  }
  const result = {
    status: "done" as const,
    conversations: read.conversations.length,
    waiting: 0,
    upToDate: 0,
    runs: [] as DesktopConversationRun[],
  };
  for (const conversation of conversations) {
    const updated = Date.parse(conversation.updatedAt);
    if (options.since && !(updated >= options.since.getTime())) continue;
    const idle = now - updated;
    // A conversation still open is left for a later run.
    const closed =
      options.latest ||
      idle >= closeMs ||
      (idle >= quietMs && updated < newest);
    if (!closed) {
      result.waiting++;
      continue;
    }
    const run = await captureOne(conversation, options.complete);
    if (run) result.runs.push(run);
    else result.upToDate++;
  }
  return result;
}

// What a stretch of a Desktop chat did (T-334): its turns and the tool calls its text names
// (`[tool name: …]`, see desktop-chat.ts). Desktop keeps no working folder, branch or model.
function desktopActivity(messages: DesktopChatMessage[]): SessionActivity {
  const tally = new ActivityTally();
  for (const message of messages) {
    if (!message.text.trim()) continue;
    tally.turn(message.sender === "human" ? "user" : "assistant");
    for (const call of message.text.matchAll(/^\[tool ([^\]:\s]+)/gm))
      tally.tool(call[1]);
  }
  return tally.result();
}

async function captureOne(
  conversation: DesktopChat,
  complete: CompleteText | null,
): Promise<DesktopConversationRun | null> {
  const dated = conversation.messages.filter((m) => m.createdAt);
  const newest = dated.reduce(
    (max, m) => (m.createdAt > max ? m.createdAt : max),
    "",
  );
  const claim = await locked(async (state) => {
    const from = state.conversations[conversation.uuid]?.to ?? "";
    // Nothing is claimed without a model, so a later run that has one still reads the turns.
    if (newest <= from || !complete) return { from, claimed: false };
    state.conversations[conversation.uuid] = {
      from,
      to: newest,
      at: new Date().toISOString(),
    };
    await writeState(state);
    return { from, claimed: true };
  });
  const base = { uuid: conversation.uuid, from: claim.from, to: newest };
  // Kept whole whether or not there is anything new, or a model to read it now.
  await keepTranscript(conversation).catch(() => {});
  if (newest <= claim.from) return null;
  if (!claim.claimed || !complete) return { ...base, status: "no-provider" };

  const turns = dated
    .filter((message) => message.createdAt > claim.from && message.text.trim())
    .map(toTurn);
  if (!turns.some((turn) => turn.role === "user"))
    return { ...base, status: "no-user-text" };
  // Decided before the call, so the model is told the project (T-335).
  const decision = await conversationProjectDecision(conversation.uuid);
  // The same call also returns the conversation's digest for the day's log (no second call).
  const extraction = await extractSessionFacts({
    turns,
    complete,
    digest: true,
    scope: await projectScope(decision.projectId),
    log: { sessionId: `desktop:${conversation.uuid}`, client: DESKTOP_CLIENT },
  });
  if (extraction.failed) {
    // Nothing was learned: hand the turns back, unless a later run already claimed past them.
    await locked(async (state) => {
      const latest = state.conversations[conversation.uuid];
      if (latest?.from === claim.from && latest.to === newest) {
        if (!claim.from) delete state.conversations[conversation.uuid];
        else
          state.conversations[conversation.uuid] = {
            from: claim.from,
            to: claim.from,
            at: new Date().toISOString(),
          };
        await writeState(state);
      }
    });
    return { ...base, status: "failed" };
  }
  const proposed = await captureSessionFacts({
    sessionId: `desktop:${conversation.uuid}`,
    client: DESKTOP_CLIENT,
    facts: extraction.facts,
  });
  let record: string | undefined;
  if (extraction.digest) {
    const times = dated
      .filter((message) => message.createdAt > claim.from)
      .map((message) => message.createdAt);
    record = (
      await writeDigestRecord({
        provider: DESKTOP_CLIENT,
        sessionId: `desktop:${conversation.uuid}`,
        startedAt: times[0] ?? newest,
        endedAt: newest,
        digest: extraction.digest,
        project: decision.projectId,
        conversationTitle: decision.title,
        claudeProject: decision.claudeProject,
        identity: decision,
        activity: desktopActivity(
          dated.filter((message) => message.createdAt > claim.from),
        ),
        ...(extraction.call ? { extraction: extraction.call } : {}),
      })
    ).path;
  }
  return {
    ...base,
    status: "done",
    ...(record ? { record } : {}),
    ...(decision.projectId ? { project: decision.projectId } : {}),
    filed: proposed.filed.map((item) => item.path),
    candidates: proposed.proposed,
    rejected: extraction.rejected.length,
    ...(extraction.triage && !extraction.triage.worth ? { trivial: true } : {}),
    ...(extraction.repeat ? { repeat: true } : {}),
    ...(proposed.unrouted.length ? { unrouted: proposed.unrouted } : {}),
    skipped: proposed.skipped.length,
  };
}
