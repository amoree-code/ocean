import { createHash } from "node:crypto";
import type { SessionStorePort } from "@ocean/core/domain/ports/session-store-port.js";
import type {
  Session,
  SessionEvent,
} from "@ocean/core/domain/sessions/session.js";
import { safeJsonParse } from "@ocean/core/shared/fs-utils.js";
import {
  detectSessionSignals,
  hasUserCorrection,
  type SessionSignal,
} from "@ocean/market/skills/task-observer.js";
import {
  addLesson,
  confirmLesson,
  contradictLesson,
  type Lesson,
  LessonRejectedError,
  readLesson,
  setLessonStatus,
} from "./lessons.js";

// What a closed session teaches the lessons store (T-230 P2). Scoring reads only signals a
// session recorded itself — its exit, its evidence events — never the model's own claims.
export const PROMOTION_HITS = 3;
const MAX_NEW_LESSONS = 4;

export type SessionScore = {
  verified: boolean;
  provenCount: number;
  unprovenCount: number;
  exitCode: number;
};

// verified = completed, exited 0, at least one proven evidence event, and none unproven.
export function scoreSession(
  session: Pick<Session, "status">,
  events: SessionEvent[],
): SessionScore {
  const exit = [...events].reverse().find((e) => e.type === "process_exit");
  const exitCode = exit
    ? Number(safeJsonParse(exit.data)?.exitCode ?? 1)
    : session.status === "completed"
      ? 0
      : 1;
  let provenCount = 0;
  let unprovenCount = 0;
  for (const event of events) {
    if (event.type !== "evidence") continue;
    if (safeJsonParse(event.data)?.result === "proven") provenCount += 1;
    else unprovenCount += 1;
  }
  return {
    verified:
      session.status === "completed" &&
      exitCode === 0 &&
      provenCount > 0 &&
      unprovenCount === 0,
    provenCount,
    unprovenCount,
    exitCode,
  };
}

export type LessonEvalResult = { passed: boolean; reason: string };
export type LessonEval = (lesson: Lesson) => Promise<LessonEvalResult>;

// The replay eval: the lesson's hits must come from at least PROMOTION_HITS distinct
// sessions, and each of those sessions must still score as verified when replayed from its
// recorded events. A hit whose session has since vanished or no longer verifies does not count.
export function replayEval(store: SessionStorePort): LessonEval {
  return async (lesson) => {
    const sessionIds = [
      ...new Set(
        lesson.evidence
          .filter((ref) => ref.startsWith("session:"))
          .map((ref) => ref.slice("session:".length)),
      ),
    ];
    const replayed = sessionIds.filter((id) => {
      const session = store.get(id);
      return session
        ? scoreSession(session, store.listEvents(id)).verified
        : false;
    });
    return replayed.length >= PROMOTION_HITS
      ? { passed: true, reason: `${replayed.length} sessions replay verified` }
      : {
          passed: false,
          reason: `${replayed.length} of ${PROMOTION_HITS} required sessions replay verified`,
        };
  };
}

export type PromotionResult = { promoted: boolean; reason: string };

// candidate → active, only with PROMOTION_HITS verified hits and a passing eval. Never
// writes to charter/: that stays an owner decision.
export async function promoteLesson(
  id: string,
  evaluate: LessonEval,
): Promise<PromotionResult> {
  const lesson = await readLesson(id);
  if (!lesson) return { promoted: false, reason: "not found" };
  if (lesson.status !== "candidate")
    return { promoted: false, reason: `already ${lesson.status}` };
  if (lesson.hits < PROMOTION_HITS)
    return {
      promoted: false,
      reason: `${lesson.hits} of ${PROMOTION_HITS} verified hits`,
    };
  const verdict = await evaluate(lesson);
  if (!verdict.passed) return { promoted: false, reason: verdict.reason };
  await setLessonStatus(id, "active");
  return { promoted: true, reason: verdict.reason };
}

function lessonIdFor(signal: SessionSignal): string {
  const digest = createHash("sha256")
    .update(`${signal.signalType}:${signal.summary.toLocaleLowerCase()}`)
    .digest("hex");
  return `lesson-${digest.slice(0, 16)}`;
}

export type LearnedSignal = {
  id: string;
  signalType: string;
  summary: string;
  confidence: number;
};

export type SessionLearning = {
  score: SessionScore;
  created: LearnedSignal[];
  confirmed: string[];
  contradicted: string[];
  promoted: string[];
  errors: string[];
};

function activatedLessonIds(events: SessionEvent[]): string[] {
  const ids = events
    .filter((event) => event.type === "skill_auto_activated")
    .map((event) => safeJsonParse(event.data)?.id)
    .filter((id): id is string => typeof id === "string");
  return [...new Set(ids)];
}

// Called once per session at closeout. A verified session confirms the lessons it used,
// turns what it did into candidate lessons, and may promote a lesson that reached the bar.
// An explicit user correction contradicts the lessons that were active when it happened.
export async function learnFromSession(
  store: SessionStorePort,
  sessionId: string,
  now: Date = new Date(),
): Promise<SessionLearning> {
  const session = store.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const events = store.listEvents(sessionId);
  const score = scoreSession(session, events);
  const learning: SessionLearning = {
    score,
    created: [],
    confirmed: [],
    contradicted: [],
    promoted: [],
    errors: [],
  };
  const evaluate = replayEval(store);
  const corrected = hasUserCorrection(events);
  const ref = `session:${sessionId}`;
  // One lesson failing (an I/O or lock error) is recorded and skipped, never thrown: the
  // changes already made to other lessons must still reach the audit event.
  const guarded = async (id: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      learning.errors.push(
        `${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const reinforce = (id: string) =>
    guarded(id, async () => {
      await confirmLesson(id, { evidence: ref, now });
      learning.confirmed.push(id);
      if ((await promoteLesson(id, evaluate)).promoted)
        learning.promoted.push(id);
    });
  for (const id of activatedLessonIds(events)) {
    await guarded(id, async () => {
      const lesson = await readLesson(id);
      // A session that was already counted (closeout retried) is never counted twice.
      if (
        !lesson ||
        lesson.status === "retired" ||
        lesson.evidence.includes(ref)
      )
        return;
      if (corrected) {
        await contradictLesson(id, {
          reason: "user corrected the session that used it",
          evidence: ref,
          now,
        });
        learning.contradicted.push(id);
      } else if (score.verified) await reinforce(id);
    });
  }
  if (!score.verified) return learning;
  for (const signal of detectSessionSignals(events).slice(0, MAX_NEW_LESSONS)) {
    const id = lessonIdFor(signal);
    await guarded(id, async () => {
      const existing = await readLesson(id);
      if (existing) {
        // Seen again in another verified session: reinforcement, which counts as a hit.
        if (existing.status !== "retired" && !existing.evidence.includes(ref))
          await reinforce(id);
        return;
      }
      try {
        // Evidence is the session only: event refs live in that session's own record, and
        // a bounded list of them would push the session refs the replay eval needs out.
        await addLesson(
          {
            id,
            title: signal.summary.slice(0, 80),
            body: signal.summary,
            confidence: signal.confidence,
            evidence: [ref],
            sourceSessionId: sessionId,
          },
          now,
        );
        learning.created.push({
          id,
          signalType: signal.signalType,
          summary: signal.summary,
          confidence: signal.confidence,
        });
      } catch (error) {
        // Refused on its own terms (e.g. the summary looks like a secret).
        if (!(error instanceof LessonRejectedError)) throw error;
      }
    });
  }
  return learning;
}
