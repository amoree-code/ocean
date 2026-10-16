import type { SessionStorePort } from "@ocean/core/domain/ports/session-store-port.js";
import type { SessionEvent } from "@ocean/core/domain/sessions/session.js";
import { safeJsonParse } from "@ocean/core/shared/fs-utils.js";
import { gitChangedFiles } from "@ocean/core/shared/project-resolution.js";
import {
  observeSessionWithStore,
  type TaskObservation,
} from "@ocean/market/skills/task-observer.js";
import { createHandoffWithStore } from "../handoff/handoff-service.js";
import { writeBrainDump } from "../memory/brain-dump.js";
import {
  appendDailyNarrative,
  appendObservations,
} from "../memory/daily-narrative.js";
import { generateModelNarrative } from "../memory/model-narrative.js";
import {
  type SessionSummaryResult,
  writeSessionSummary,
} from "../memory/session-summary.js";

export type SessionCloseoutResult = SessionSummaryResult & {
  handoffId: string | null;
  closeoutStatus: "completed" | "failed";
};

async function changedFiles(workingDirectory: string): Promise<string[]> {
  return (await gitChangedFiles(workingDirectory)).slice(0, 100);
}

function lastEvent(
  events: SessionEvent[],
  type: string,
): SessionEvent | undefined {
  return [...events].reverse().find((event) => event.type === type);
}

function evidence(
  events: SessionEvent[],
  result: "proven" | "notProven" | "blocked",
): string[] {
  return events
    .filter(
      (event) => event.type === "evidence" || event.type === "provider_blocked",
    )
    .map((event) => {
      const value = safeJsonParse(event.data);
      if (event.type === "provider_blocked")
        return result === "blocked"
          ? String(value?.reason ?? event.data)
          : null;
      const proven = value?.result === "proven";
      if (result === "proven" && proven)
        return String(value?.criterion ?? "verified result");
      if (result === "notProven" && !proven)
        return String(value?.criterion ?? value?.result ?? "not proven");
      return null;
    })
    .filter((value): value is string => Boolean(value))
    .slice(0, 12);
}

export async function finalizeSession(
  store: SessionStorePort,
  sessionId: string,
  input: { exitCode?: number; nextAction?: string } = {},
): Promise<SessionCloseoutResult> {
  const session = store.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  // finalizeSession can legitimately be invoked more than once for the same session
  // (e.g. a caller's success path completes closeout, then a later step in that same
  // caller throws and its catch block calls finalizeSession again). The summary/handoff
  // work below is already idempotent (guarded by existing handoffId / session_summary
  // event checks), but the daily-narrative append is a pure side effect with no such
  // check, so a re-run would otherwise write a duplicate "Work log" line. closedAt is
  // only ever set by the updateCloseout call further down, so its presence here means
  // this session has already been closed out once.
  const alreadyClosedOut = Boolean(session.closedAt);
  const events = store.listEvents(sessionId);
  const exitEvent = lastEvent(events, "process_exit");
  const exitCode =
    input.exitCode ??
    (exitEvent
      ? Number(safeJsonParse(exitEvent.data)?.exitCode ?? 1)
      : session.status === "completed"
        ? 0
        : 1);
  const closeoutStatus =
    session.status === "completed" && exitCode === 0 ? "completed" : "failed";
  const files = await changedFiles(session.workingDirectory);
  const summary = await writeSessionSummary({
    session,
    events,
    changedFiles: files,
    exitCode,
    nextAction: input.nextAction,
  });
  let handoffId = session.handoffId;
  const enoughEvidence = Boolean(
    session.taskId ||
      (closeoutStatus === "completed" &&
        events.some((event) =>
          ["user_input", "provider_output", "text", "json"].includes(
            event.type,
          ),
        )),
  );
  if (!handoffId && enoughEvidence) {
    try {
      const handoff = await createHandoffWithStore(store, {
        sessionId,
        taskId: session.taskId ?? undefined,
        nextAction: input.nextAction,
        sourceSummaryPath: summary.summaryPath,
        changedFiles: files,
        verification: evidence(events, "proven"),
        notProven: evidence(events, "notProven"),
        blocked: evidence(events, "blocked"),
      });
      handoffId = handoff.handoffId;
    } catch (error) {
      store.appendEvent(
        sessionId,
        "closeout_warning",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const closedAt = new Date().toISOString();
  store.updateCloseout(sessionId, { ...summary, closeoutStatus, closedAt });
  if (!alreadyClosedOut) {
    // Computed first so writeBrainDump can surface the same signals as the
    // daily narrative, but kept in its own try/catch: a failure here must
    // not skip the narrative/summary work below, and vice versa.
    let observations: TaskObservation[] = [];
    try {
      observations = await observeSessionWithStore(store, sessionId);
      await appendObservations(session, observations);
    } catch (error) {
      store.appendEvent(
        sessionId,
        "closeout_warning",
        error instanceof Error ? error.message : String(error),
      );
    }
    try {
      const narrative = await generateModelNarrative({
        session,
        events,
        changedFiles: files,
        nextAction: input.nextAction,
      });
      await appendDailyNarrative({
        session,
        events,
        exitCode,
        nextAction: input.nextAction,
        narrative,
      });
      await writeBrainDump({
        session,
        events,
        changedFiles: files,
        exitCode,
        nextAction: input.nextAction,
        narrative,
        observations,
      });
    } catch (error) {
      store.appendEvent(
        sessionId,
        "closeout_warning",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (
    !store
      .listEvents(sessionId)
      .some((event) => event.type === "session_summary")
  ) {
    store.appendEvent(
      sessionId,
      "session_summary",
      JSON.stringify({ ...summary, handoffId, closeoutStatus, closedAt }),
    );
  }
  return { ...summary, handoffId, closeoutStatus };
}
