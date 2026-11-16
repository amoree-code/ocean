import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeDigestRecord } from "@ocean/brain/memory/brain-dump.js";
import { sessionFactsEnabled } from "@ocean/brain/memory/memory-audit.js";
import {
  type CompleteText,
  extractSessionFacts,
  type FactTurn,
  proposeSessionFacts,
} from "@ocean/brain/memory/session-facts.js";
import { atomicWrite, withFileLock } from "@ocean/core/shared/fs-utils.js";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";

// Fact capture from Claude Desktop's plain chat (T-315). Desktop has no hooks, so a run reads
// the conversations the app keeps locally (the reader is injected: it lives in harness) and
// sends the new turns of each conversation that has gone quiet to the same extraction T-313
// uses. A per-conversation cursor — the creation time of the newest message already claimed,
// which the app's store and the official export both carry — makes every turn read once,
// whichever source it came from: a run claims (cursor, newest] under a short lock, calls the
// model unlocked,
// and hands the turns back if the model gave no answer. Candidates carry
// `source: session:desktop:<uuid>`, so they are never auto-approved. No message text is ever
// written outside the candidates themselves: the state file and the run report hold ids,
// times and counts only.

export const DESKTOP_CLIENT = "claude-desktop";
export const DEFAULT_QUIET_MS = 10 * 60 * 1000;

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
  candidates?: string[];
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
  quietMs?: number;
  since?: Date;
  enabled?: () => Promise<boolean>;
}): Promise<DesktopFactsRun> {
  if (!(await (options.enabled ?? sessionFactsEnabled)()))
    return { status: "off" };
  const read = await options.read();
  if (read.status === "absent") return { status: "absent" };
  const now = (options.now ?? new Date()).getTime();
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  const result = {
    status: "done" as const,
    conversations: read.conversations.length,
    waiting: 0,
    upToDate: 0,
    runs: [] as DesktopConversationRun[],
  };
  for (const conversation of read.conversations) {
    const updated = Date.parse(conversation.updatedAt);
    if (options.since && !(updated >= options.since.getTime())) continue;
    // A conversation still being written is left for a later run.
    if (!(updated <= now - quietMs)) {
      result.waiting++;
      continue;
    }
    const run = await captureOne(conversation, options.complete);
    if (run) result.runs.push(run);
    else result.upToDate++;
  }
  return result;
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
  if (newest <= claim.from) return null;
  if (!claim.claimed || !complete) return { ...base, status: "no-provider" };

  const turns = dated
    .filter((message) => message.createdAt > claim.from && message.text.trim())
    .map(toTurn);
  if (!turns.some((turn) => turn.role === "user"))
    return { ...base, status: "no-user-text" };
  // The same call also returns the conversation's digest for the day's log (no second call).
  const extraction = await extractSessionFacts({
    turns,
    complete,
    digest: true,
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
  const proposed = await proposeSessionFacts({
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
      })
    ).path;
  }
  return {
    ...base,
    status: "done",
    ...(record ? { record } : {}),
    candidates: proposed.proposed,
    rejected: extraction.rejected.length,
    skipped: proposed.skipped.length,
  };
}
