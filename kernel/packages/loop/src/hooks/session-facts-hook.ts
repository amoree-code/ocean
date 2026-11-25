import { mkdir, open, stat } from "node:fs/promises";
import path from "node:path";
import { writeDigestRecord } from "@ocean/brain/memory/brain-dump.js";
import { sessionFactsEnabled } from "@ocean/brain/memory/memory-audit.js";
import {
  type CompleteText,
  captureSessionFacts,
  extractSessionFacts,
  type FactTurn,
} from "@ocean/brain/memory/session-facts.js";
import type {
  SessionStoreFactory,
  SessionStorePort,
} from "@ocean/core/domain/ports/session-store-port.js";
import { sessionIdentity } from "@ocean/core/domain/sessions/session-identity.js";
import {
  ActivityTally,
  type SessionActivity,
} from "@ocean/core/domain/sessions/session-metadata.js";
import { safeJsonParse, withFileLock } from "@ocean/core/shared/fs-utils.js";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import {
  findGitRoot,
  repoRelative,
} from "@ocean/core/shared/project-resolution.js";
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
): Promise<TranscriptSlice> {
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
  const tally = new ActivityTally();
  let cwd: string | undefined;
  let first: string | undefined;
  let last: string | undefined;
  for (const line of lines) {
    const record = line.trim() ? safeJsonParse(line) : null;
    const at = record ? lineTime(record) : undefined;
    if (at) {
      first ??= at;
      last = at;
    }
    if (!record || record.isMeta === true) continue;
    cwd = noteActivity(record, client, tally) ?? cwd;
    const turn = transcriptTurn(record, client);
    if (!turn) continue;
    const text = turn.role === "user" ? userText(turn.text) : turn.text.trim();
    if (text) {
      turns.push({ role: turn.role, text });
      tally.turn(turn.role);
    }
  }
  return {
    turns,
    offset: start + lastNewline + 1,
    activity: tally.result(),
    ...(cwd ? { cwd } : {}),
    ...(first ? { first } : {}),
    ...(last ? { last } : {}),
  };
}

export type TranscriptSlice = {
  turns: FactTurn[];
  offset: number;
  // What the stretch did (T-334): turns, tool calls, touched paths (as the transcript names
  // them), the model and the branch, counted from the lines, never asked of a model.
  activity?: SessionActivity;
  // The working folder the transcript names, which its touched paths are relative to.
  cwd?: string;
  // The first and last line timestamps read, when the transcript carries them.
  first?: string;
  last?: string;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

// The path a tool call's input names, if any.
function inputPath(input: unknown): string | undefined {
  const fields = asRecord(
    typeof input === "string" ? safeJsonParse(input) : input,
  );
  const found = fields?.file_path ?? fields?.notebook_path ?? fields?.path;
  return typeof found === "string" && found ? found : undefined;
}

// One transcript line's model, branch and tool calls into the tally; returns the working folder
// the line names. Claude Code stamps cwd and gitBranch on each line and lists tool_use blocks
// in assistant messages; Codex keeps them in session_meta, turn_context and response_item lines.
function noteActivity(
  record: Record<string, unknown>,
  client: SessionEndClient,
  tally: ActivityTally,
): string | undefined {
  if (client === "codex") {
    const payload = asRecord(record.payload);
    if (!payload) return undefined;
    if (record.type === "session_meta")
      tally.branch(asRecord(payload.git)?.branch);
    if (record.type === "turn_context") tally.model(payload.model);
    if (
      record.type === "response_item" &&
      typeof payload.type === "string" &&
      /call$/.test(payload.type) &&
      !/output$/.test(payload.type)
    )
      tally.tool(
        typeof payload.name === "string" ? payload.name : payload.type,
        inputPath(payload.arguments ?? payload.input),
      );
    return typeof payload.cwd === "string" ? payload.cwd : undefined;
  }
  tally.branch(record.gitBranch);
  if (record.type === "assistant") {
    const message = asRecord(record.message);
    tally.model(message?.model);
    if (Array.isArray(message?.content))
      for (const block of message.content) {
        const each = asRecord(block);
        if (each?.type === "tool_use" && typeof each.name === "string")
          tally.tool(each.name, inputPath(each.input));
      }
  }
  return typeof record.cwd === "string" ? record.cwd : undefined;
}

// The tally's touched paths made repo-relative, for the record.
export function recordActivity(
  activity: SessionActivity | undefined,
  cwd: string | undefined,
): SessionActivity | undefined {
  if (!activity) return undefined;
  const root = cwd ? findGitRoot(cwd) : null;
  const files: Record<string, number> = {};
  for (const [file, count] of Object.entries(activity.files)) {
    const relative = repoRelative(
      cwd && !path.isAbsolute(file) ? path.resolve(cwd, file) : file,
      root,
    );
    files[relative] = (files[relative] ?? 0) + count;
  }
  return { ...activity, files };
}

// A transcript line's own time: Claude Code and Codex both stamp each line at the top level.
function lineTime(record: Record<string, unknown>): string | undefined {
  const at = record.timestamp;
  return typeof at === "string" && Number.isFinite(Date.parse(at))
    ? new Date(at).toISOString()
    : undefined;
}

// How much of a transcript's head is read to find when it started.
const HEAD_BYTES = 64 * 1024;

// When the transcript started: the first timestamp in its head, or undefined.
export async function transcriptStart(
  transcriptPath: string,
): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(transcriptPath, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    for (const line of buffer
      .subarray(0, bytesRead)
      .toString("utf8")
      .split("\n")) {
      const record = line.trim() ? safeJsonParse(line) : null;
      const at = record ? lineTime(record) : undefined;
      if (at) return at;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
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

// The session's real span: the transcript's first timestamp to the last one read. Capture time
// only when the transcript carries none.
async function digestTimes(
  transcriptPath: string,
  slice: TranscriptSlice,
): Promise<{ startedAt: string; endedAt: string }> {
  const now = new Date().toISOString();
  const startedAt =
    (await transcriptStart(transcriptPath)) ?? slice.first ?? now;
  const endedAt = slice.last ?? now;
  return { startedAt, endedAt: endedAt < startedAt ? startedAt : endedAt };
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
      record?: string;
      // Records filed on their own (T-329 phase 3); candidates wait for the owner's review.
      filed: string[];
      candidates: string[];
      // Free triage found nothing worth a model call (T-329 phase 2).
      trivial?: boolean;
      rejected: number;
      skipped: number;
    };

export async function runSessionFacts(
  payload: ClaudeSessionEndPayload,
  openStore: SessionStoreFactory,
  client: SessionEndClient,
  completer: FactsCompleter,
  // digest: the same call also returns the stretch's summary, written as a session record so a
  // long session is in the day's account before it ends (T-314) — no second model call.
  options: { enabled?: () => Promise<boolean>; digest?: boolean } = {},
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
      const session = await ensureHookSession(
        store,
        sessionId,
        client,
        payloadCwd(payload),
      );
      // The project and task were decided when the session was created; read, never recomputed.
      const identity = sessionIdentity(
        session ?? { projectId: null, taskId: null },
        store.listEvents(sessionId),
      );
      const from = latestClaim(store, sessionId, transcriptPath)?.to ?? 0;
      const slice = await readTranscriptSlice(transcriptPath, client, from);
      if (slice.offset === from)
        return { from, slice, identity, claimed: false };
      if (!complete) return { from, slice, identity, claimed: false };
      store.appendEvent(
        sessionId,
        FACTS_CLAIM_EVENT,
        JSON.stringify({ transcript: transcriptPath, from, to: slice.offset }),
      );
      return { from, slice, identity, claimed: true };
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
    digest: options.digest,
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
  const proposed = await captureSessionFacts({
    sessionId,
    client,
    facts: extraction.facts,
  });
  let record: string | undefined;
  if (extraction.digest) {
    record = (
      await writeDigestRecord({
        provider: client,
        sessionId,
        ...(await digestTimes(transcriptPath, claim.slice)),
        digest: extraction.digest,
        project: claim.identity.projectId,
        task: claim.identity.taskId,
        identity: claim.identity,
        activity: recordActivity(
          claim.slice.activity,
          claim.slice.cwd ?? payloadCwd(payload),
        ),
        ...(extraction.call ? { extraction: extraction.call } : {}),
      })
    ).path;
  }
  const run: SessionFactsRun = {
    status: "done",
    ...(record ? { record } : {}),
    from: claim.from,
    to: claim.slice.offset,
    filed: proposed.filed.map((item) => item.path),
    candidates: proposed.proposed,
    rejected: extraction.rejected.length,
    ...(extraction.triage && !extraction.triage.worth ? { trivial: true } : {}),
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
