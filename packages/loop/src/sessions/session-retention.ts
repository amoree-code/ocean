import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { writeSessionSummary } from "@ocean/brain/memory/session-summary.js";
import type {
  SessionStoreOpener,
  SessionStorePort,
} from "@ocean/core/domain/ports/session-store-port.js";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";

// Session retention (T-228): summarize finished, unsummarized sessions to markdown, then
// prune their raw provider_output/terminal_input events (never a session row, a handoff, an
// idea, or a capture-referenced event), then checkpoint+VACUUM. Default mode is dry-run
// (planRetention only); simulate measures a VACUUMed copy; apply is fingerprint-gated and is
// never invoked against the live sessions.sqlite by this task — only against fixture
// databases in tests.

export const DEFAULT_KEEP_DAYS = 7;

export type RetentionPlan = {
  before: string;
  keepDays: number;
  sessionIds: string[];
  needSummary: string[];
  eventIds: number[];
  dataBytes: number;
  fingerprint: string;
};

function computeFingerprint(
  before: string,
  types: readonly string[],
  sessionIds: string[],
  eventIds: number[],
): string {
  const sorted = [...sessionIds].sort();
  // Not Math.max(...eventIds): spreading tens of thousands of event ids as call arguments
  // overflows the engine's argument-count limit (RangeError: Maximum call stack size
  // exceeded) on a real corpus, even though small fixture-scale tests never hit it.
  let maxEventId = 0;
  for (const id of eventIds) if (id > maxEventId) maxEventId = id;
  return createHash("sha256")
    .update(
      JSON.stringify({
        before,
        types: [...types].sort(),
        sessionIds: sorted,
        eventCount: eventIds.length,
        maxEventId,
      }),
    )
    .digest("hex");
}

export function planRetention(
  store: SessionStorePort,
  options: { keepDays?: number; before?: string; now?: number } = {},
): RetentionPlan {
  const keepDays = options.keepDays ?? DEFAULT_KEEP_DAYS;
  const before =
    options.before ??
    new Date(
      (options.now ?? Date.now()) - keepDays * 24 * 60 * 60 * 1000,
    ).toISOString();
  const sessions = store.retentionEligibleSessions(before);
  const sessionIds = sessions.map((session) => session.sessionId);
  const needSummary = sessions
    .filter((session) => !session.summaryPath)
    .map((session) => session.sessionId);
  const eventIds = store.retentionPrunableEventIds(sessionIds);
  const dataBytes = store.eventsDataBytes(eventIds);
  const RAW_EVENT_TYPES = ["provider_output", "terminal_input"];
  return {
    before,
    keepDays,
    sessionIds,
    needSummary,
    eventIds,
    dataBytes,
    fingerprint: computeFingerprint(
      before,
      RAW_EVENT_TYPES,
      sessionIds,
      eventIds,
    ),
  };
}

export type SimulationResult = {
  beforeBytes: number;
  afterBytes: number;
  freedBytes: number;
  plan: RetentionPlan;
};

// Measures the effect of applying `plan` against a throwaway VACUUMed COPY of the database
// file backing `store` — the live file is never touched. The copy lives under a private,
// mode-0700 directory (never /tmp), and is always removed, even on error.
export async function simulateRetention(
  store: SessionStorePort,
  _sourceFile: string,
  plan: RetentionPlan,
  openStore: SessionStoreOpener,
): Promise<SimulationResult> {
  const simDir = oceanPath(SYSTEM_DIR, "sessions", ".compaction-sim");
  await mkdir(simDir, { recursive: true, mode: 0o700 });
  const copyPath = path.join(simDir, `sim-${process.pid}-${Date.now()}.sqlite`);
  await rm(copyPath, { force: true });
  try {
    await store.backupTo(copyPath);
    const beforeBytes = (await stat(copyPath)).size;

    const copyStore = openStore(copyPath);
    try {
      copyStore.deleteEvents(plan.eventIds);
      copyStore.checkpointAndVacuum();
    } finally {
      copyStore.close();
    }
    const afterBytes = (await stat(copyPath)).size;
    return {
      beforeBytes,
      afterBytes,
      freedBytes: beforeBytes - afterBytes,
      plan,
    };
  } finally {
    await rm(copyPath, { force: true });
    await rm(`${copyPath}-wal`, { force: true });
    await rm(`${copyPath}-shm`, { force: true });
  }
}

export type ApplyResult = {
  backupPath: string;
  summarized: string[];
  eventsDeleted: number;
  beforeBytes: number;
  afterBytes: number;
};

// Fingerprint-gated: refuses to run if `fingerprint` does not match a freshly recomputed
// plan for the same `before`/keepDays — the database must not have moved out from under the
// plan between planning and applying. Backs up first, summarizes any unsummarized finished
// session (verifying the written file's hash before trusting it), deletes only the planned
// event ids, appends one audit event per session, then checkpoints+VACUUMs.
export async function applyRetention(
  store: SessionStorePort,
  sourceFile: string,
  plan: RetentionPlan,
  fingerprint: string,
): Promise<ApplyResult> {
  const fresh = planRetention(store, {
    keepDays: plan.keepDays,
    before: plan.before,
  });
  if (
    fresh.fingerprint !== fingerprint ||
    fresh.fingerprint !== plan.fingerprint
  ) {
    throw new Error(
      "retention plan fingerprint mismatch — the database changed since this plan was made; refusing to apply a stale plan",
    );
  }

  const backupDir = oceanPath(SYSTEM_DIR, "sessions", ".backups");
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const backupPath = path.join(backupDir, `sessions-${Date.now()}.sqlite`);
  await store.backupTo(backupPath);
  const beforeBytes = (await stat(sourceFile)).size;

  const summarized: string[] = [];
  for (const sessionId of plan.needSummary) {
    const session = store.get(sessionId);
    if (!session) continue;
    const events = store.listEvents(sessionId);
    const written = await writeSessionSummary({ session, events });
    store.setSummary(sessionId, written);
    summarized.push(sessionId);
  }

  store.deleteEvents(plan.eventIds);
  // Retention's audit event is best-effort and coarse (the total pruned count for the whole
  // plan, not a precise per-session breakdown), recorded once against every planned session.
  for (const sessionId of plan.sessionIds) {
    store.recordRetentionPrune(sessionId, plan.eventIds.length, plan.before);
  }
  store.checkpointAndVacuum();
  const afterBytes = (await stat(sourceFile)).size;

  return {
    backupPath,
    summarized,
    eventsDeleted: plan.eventIds.length,
    beforeBytes,
    afterBytes,
  };
}
