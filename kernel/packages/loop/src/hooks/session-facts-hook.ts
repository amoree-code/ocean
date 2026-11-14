import { mkdir, open, stat } from "node:fs/promises";
import path from "node:path";
import { sessionFactsEnabled } from "@ocean/brain/memory/memory-audit.js";
import {
  type CompleteText,
  extractSessionFacts,
  type FactTurn,
  proposeSessionFacts,
} from "@ocean/brain/memory/session-facts.js";
import type {
  SessionStoreFactory,
  SessionStorePort,
} from "@ocean/core/domain/ports/session-store-port.js";
import { safeJsonParse, withFileLock } from "@ocean/core/shared/fs-utils.js";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import {
  type ClaudeSessionEndPayload,
  ensureHookSession,
  payloadCwd,
  type SessionEndClient,
  TRANSCRIPT_CLIENTS,
  transcriptTurn,
} from "./session-end-hook.js";

// Fact capture from a client's transcript (T-313), run by `ocean hook session-facts` in the
// background after SessionEnd and PreCompact (a hook itself has seconds; a model call takes
// longer). A per-session cursor — the transcript byte offset already claimed — makes PreCompact
// then SessionEnd read each turn once: a run claims [cursor, end of the last complete line)
// under a short lock, records the claim as a session event, then calls the model unlocked.

// The most of a transcript one run reads; a longer unread part keeps its newest end.
const MAX_SLICE_BYTES = 4 * 1024 * 1024;

export const FACTS_CLAIM_EVENT = "memory_extract_claim";
export const FACTS_DONE_EVENT = "memory_extracted";

// Claude Code adds its own text to user turns: reminders, slash-command echoes, local command
// output. None of it is something the user said.
function userText(text: string): string {
  const stripped = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
    .trim();
  if (
    /^<(command-|local-command-|bash-|user-prompt-submit-hook)/.test(
      stripped,
    ) ||
    stripped.startsWith("Caveat: The messages below")
  )
    return "";
  return stripped;
}

// The complete lines after `from`, as turns, and the offset just past the last of them. A line
// still being written (no newline yet) is left for the next run.
export async function readTranscriptSlice(
  transcriptPath: string,
  client: SessionEndClient,
  from = 0,
): Promise<{ turns: FactTurn[]; offset: number }> {
  let size: number;
  try {
    size = (await stat(transcriptPath)).size;
  } catch {
    return { turns: [], offset: from };
  }
  // A transcript shorter than the cursor was replaced: read it from the start.
  let start = size < from ? 0 : from;
  let partialFirst = false;
  if (size - start > MAX_SLICE_BYTES) {
    start = size - MAX_SLICE_BYTES;
    partialFirst = true;
  }
  if (size <= start) return { turns: [], offset: start };
  const buffer = Buffer.alloc(size - start);
  const handle = await open(transcriptPath, "r");
  try {
    await handle.read(buffer, 0, buffer.length, start);
  } finally {
    await handle.close();
  }
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline < 0) return { turns: [], offset: start };
  const lines = buffer.subarray(0, lastNewline).toString("utf8").split("\n");
  if (partialFirst) lines.shift();
  const turns: FactTurn[] = [];
  for (const line of lines) {
    const record = line.trim() ? safeJsonParse(line) : null;
    if (!record || record.isMeta === true) continue;
    const turn = transcriptTurn(record, client);
    if (!turn) continue;
    const text = turn.role === "user" ? userText(turn.text) : turn.text.trim();
    if (text) turns.push({ role: turn.role, text });
  }
  return { turns, offset: start + lastNewline + 1 };
}

// The cursor: where the latest claim for this transcript ended. Each claim starts at the
// cursor, so claims only move it forward, except a rewind, which a failed run appends to hand
// its turns back (only while its claim is still the latest one).
function latestClaim(
  store: SessionStorePort,
  sessionId: string,
  transcriptPath: string,
): { from: number; to: number } | null {
  let latest: { from: number; to: number } | null = null;
  for (const event of store.listEvents(sessionId)) {
    if (event.type !== FACTS_CLAIM_EVENT) continue;
    const claim = safeJsonParse(event.data);
    if (claim?.transcript !== transcriptPath) continue;
    if (typeof claim.from === "number" && typeof claim.to === "number")
      latest = { from: claim.from, to: claim.to };
  }
  return latest;
}

function lockFile(sessionId: string): string {
  return oceanPath(
    SYSTEM_DIR,
    "state",
    "memory",
    "extract",
    sessionId.replace(/[^A-Za-z0-9_-]/g, "_"),
  );
}

// The model for one client's run, or null when that client cannot run headless here.
export type FactsCompleter = (client: SessionEndClient) => CompleteText | null;

export type SessionFactsRun =
  | { status: "off" | "no-transcript" | "nothing-new" }
  | { status: "no-provider" | "failed"; from: number; to: number }
  | {
      status: "done";
      from: number;
      to: number;
      candidates: string[];
      rejected: number;
      skipped: number;
    };

export async function runSessionFacts(
  payload: ClaudeSessionEndPayload,
  openStore: SessionStoreFactory,
  client: SessionEndClient,
  completer: FactsCompleter,
  options: { enabled?: () => Promise<boolean> } = {},
): Promise<SessionFactsRun> {
  if (!(await (options.enabled ?? sessionFactsEnabled)()))
    return { status: "off" };
  const sessionId = payload.session_id;
  const transcript = payload.transcript_path;
  if (!sessionId || !transcript || !TRANSCRIPT_CLIENTS.includes(client))
    return { status: "no-transcript" };
  const transcriptPath = path.resolve(transcript);
  const complete = completer(client);

  await mkdir(path.dirname(lockFile(sessionId)), {
    recursive: true,
    mode: 0o700,
  });
  // Claim the unread turns. Without a model nothing is claimed, so a later run that has one
  // still reads them.
  const claim = await withFileLock(lockFile(sessionId), async () => {
    const store = await openStore();
    try {
      await ensureHookSession(store, sessionId, client, payloadCwd(payload));
      const from = latestClaim(store, sessionId, transcriptPath)?.to ?? 0;
      const slice = await readTranscriptSlice(transcriptPath, client, from);
      if (slice.offset === from) return { from, slice, claimed: false };
      if (!complete) return { from, slice, claimed: false };
      store.appendEvent(
        sessionId,
        FACTS_CLAIM_EVENT,
        JSON.stringify({ transcript: transcriptPath, from, to: slice.offset }),
      );
      return { from, slice, claimed: true };
    } finally {
      store.close();
    }
  });
  if (claim.slice.offset === claim.from) return { status: "nothing-new" };
  if (!complete || !claim.claimed)
    return { status: "no-provider", from: claim.from, to: claim.slice.offset };

  const extraction = await extractSessionFacts({
    turns: claim.slice.turns,
    complete,
  });
  if (extraction.failed) {
    // Nothing was learned: hand the turns back, unless a later run already claimed past them.
    await withFileLock(lockFile(sessionId), async () => {
      const store = await openStore();
      try {
        const latest = latestClaim(store, sessionId, transcriptPath);
        if (latest?.from === claim.from && latest.to === claim.slice.offset)
          store.appendEvent(
            sessionId,
            FACTS_CLAIM_EVENT,
            JSON.stringify({
              transcript: transcriptPath,
              from: claim.slice.offset,
              to: claim.from,
              rewind: true,
            }),
          );
      } finally {
        store.close();
      }
    });
    return { status: "failed", from: claim.from, to: claim.slice.offset };
  }
  const proposed = await proposeSessionFacts({
    sessionId,
    client,
    facts: extraction.facts,
  });
  const run: SessionFactsRun = {
    status: "done",
    from: claim.from,
    to: claim.slice.offset,
    candidates: proposed.proposed,
    rejected: extraction.rejected.length,
    skipped: proposed.skipped.length,
  };
  const store = await openStore();
  try {
    store.appendEvent(sessionId, FACTS_DONE_EVENT, JSON.stringify(run));
  } finally {
    store.close();
  }
  return run;
}
