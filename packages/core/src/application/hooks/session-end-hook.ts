import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import readline from "node:readline";
import type { SessionStoreFactory } from "../../domain/ports/session-store-port.js";
import { finalizeSession } from "../memory/session-closeout.js";
import { sessionProjectId } from "../sessions/session-projects.js";

// The documented Claude Code SessionEnd hook contract (same family as the
// SessionStart payload in session-start-hook.ts): a small JSON payload on
// stdin naming the session and, uniquely to SessionEnd, a transcript_path to
// that session's own JSONL conversation log.
export type ClaudeSessionEndPayload = {
  cwd?: string;
  session_id?: string;
  transcript_path?: string;
  reason?: string;
  hook_event_name?: string;
};

type TranscriptEvent = { type: "user_input" | "provider_output"; data: string };

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 30;
const MAX_EVENT_CHARS = 800;

function safeSlice(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join(" ");
}

/**
 * Extracts a bounded set of plain-text user/assistant turns from a Claude
 * Code transcript (JSONL: one record per line, {type, message:{role,
 * content}}). Skips tool calls, thinking blocks, and any non-text content —
 * this feeds the same human-narrative pipeline intercepted CLI sessions use
 * (see session-closeout.ts), not a full transcript mirror. Returns the most
 * recent MAX_EVENTS turns; never throws (a missing/oversized/malformed
 * transcript just yields no events, and the caller still closes out the
 * session on its title alone).
 */
export async function readTranscriptEvents(
  transcriptPath: string,
): Promise<TranscriptEvent[]> {
  try {
    const info = await stat(transcriptPath);
    if (info.size > MAX_TRANSCRIPT_BYTES) return [];
  } catch {
    return [];
  }
  const events: TranscriptEvent[] = [];
  try {
    const rl = readline.createInterface({
      input: createReadStream(transcriptPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let record: {
        type?: string;
        message?: { role?: string; content?: unknown };
      };
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.type !== "user" && record.type !== "assistant") continue;
      const text = safeSlice(
        textFromContent(record.message?.content),
        MAX_EVENT_CHARS,
      );
      if (!text) continue;
      events.push({
        type: record.type === "user" ? "user_input" : "provider_output",
        data: text,
      });
    }
    rl.close();
  } catch {
    return [];
  }
  return events.slice(-MAX_EVENTS);
}

/**
 * SessionEnd counterpart to claudeSessionStartHook. Unlike SessionStart
 * (context injection only, no session-store write), this registers the
 * Claude Code session in sessions.sqlite the first time it is seen, replays
 * its transcript as bounded user_input/provider_output events, and runs it
 * through the same finalizeSession pipeline as `ocean run` and `ocean
 * intercept` sessions — producing the summary, daily narrative, and
 * brain/00-inbox/brain-dump/ entry. Reuses the sessionId Claude Code itself
 * assigned, so a hook re-run for the same session (e.g. `/clear` followed by
 * another SessionEnd) is idempotent via finalizeSession's own closeout guard.
 * Best-effort throughout: any failure is swallowed so a broken hook can never
 * block the user's actual session from ending.
 */
export async function claudeSessionEndHook(
  payload: ClaudeSessionEndPayload,
  openStore: SessionStoreFactory,
): Promise<void> {
  const sessionId = payload.session_id;
  if (!sessionId) return;
  const cwd = payload.cwd ?? process.cwd();

  const store = await openStore();
  try {
    let session = store.get(sessionId);
    if (!session) {
      store.create({
        sessionId,
        provider: "claude",
        providerSessionId: sessionId,
        parentSessionId: null,
        profile: "desktop:claude",
        profileIdentity: "",
        workingDirectory: cwd,
        resumeData: null,
        projectId: await sessionProjectId(cwd),
      });
      store.updateStatus(sessionId, "running");
      session = store.get(sessionId);
    }
    if (!session || session.closedAt) return;

    const events = payload.transcript_path
      ? await readTranscriptEvents(payload.transcript_path)
      : [];
    for (const event of events)
      store.appendEvent(sessionId, event.type, event.data);
    store.appendEvent(
      sessionId,
      "process_exit",
      JSON.stringify({ exitCode: 0 }),
    );
    if (session.status !== "completed")
      store.updateStatus(sessionId, "completed");

    await finalizeSession(store, sessionId, { exitCode: 0 });
  } catch {
    // Best-effort: never surface a hook failure to the user's session end.
  } finally {
    store.close();
  }
}
