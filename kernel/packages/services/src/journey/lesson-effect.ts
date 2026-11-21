import { scoreSession } from "@ocean/brain/memory/lesson-learning.js";
import type {
  Session,
  SessionEvent,
} from "@ocean/core/domain/sessions/session.js";
import { safeJsonParse } from "@ocean/core/shared/fs-utils.js";
import type { FailureRecord } from "./failures.js";
import { failureSignature } from "./telemetry.js";

// Does a lesson help? (T-323, ACE): every injected lesson leaves a `lesson_applied` event, so the
// sessions that had it can be compared with comparable sessions that did not — on verified rate,
// and, for a lesson tied to a failure record, on how often that failure's signature appeared.
// A lesson that does no better on either, with enough sessions on both sides, is proposed for
// retirement; nothing is retired without the owner.

// `skill_auto_activated` is the same event under its name before T-323.
export const LESSON_APPLIED_TYPES = new Set([
  "lesson_applied",
  "skill_auto_activated",
]);
// Lessons are only ever injected into runs that assembled context; others are not comparable.
const COMPARABLE_EVENT = "context_manifest";
export const MIN_SAMPLE = 5;

export function appliedLessonIds(events: SessionEvent[]): string[] {
  const ids = events
    .filter((event) => LESSON_APPLIED_TYPES.has(event.type))
    .map((event) => safeJsonParse(event.data)?.id)
    .filter((id): id is string => typeof id === "string");
  return [...new Set(ids)];
}

type Side = { sessions: number; verified: number; recurred: number };

export type LessonEffect = {
  lesson: string;
  with: Side;
  without: Side;
  // A failure record this lesson guards, whose signature is the recurrence measured.
  failure: string | null;
  verdict: "helps" | "no-better" | "too-few";
};

const rate = (n: number, of: number) => (of ? n / of : 0);

export function lessonEffects(
  sessions: Session[],
  eventsOf: (sessionId: string) => SessionEvent[],
  sinceIso: string,
  failures: FailureRecord[] = [],
): LessonEffect[] {
  const runs = sessions
    .filter((session) => session.createdAt >= sinceIso)
    .map((session) => {
      const events = eventsOf(session.sessionId);
      return { session, events };
    })
    .filter(({ events }) => events.some((e) => e.type === COMPARABLE_EVENT))
    .map(({ session, events }) => ({
      verified: scoreSession(session, events).verified,
      applied: new Set(appliedLessonIds(events)),
      signatures: new Set(
        events
          .map((event) => failureSignature(event.type, event.data))
          .filter((signature): signature is string => signature !== null),
      ),
    }));
  const lessons = new Set(runs.flatMap((run) => [...run.applied]));
  return [...lessons].sort().map((lesson) => {
    const failure = failures.find((record) => record.lesson === lesson) ?? null;
    const sides = { with: blank(), without: blank() };
    for (const run of runs) {
      const side = run.applied.has(lesson) ? sides.with : sides.without;
      side.sessions++;
      if (run.verified) side.verified++;
      if (failure && run.signatures.has(failure.signature)) side.recurred++;
    }
    const enough =
      sides.with.sessions >= MIN_SAMPLE && sides.without.sessions >= MIN_SAMPLE;
    const betterVerified =
      rate(sides.with.verified, sides.with.sessions) >
      rate(sides.without.verified, sides.without.sessions);
    const fewerRecurrences =
      failure !== null &&
      rate(sides.with.recurred, sides.with.sessions) <
        rate(sides.without.recurred, sides.without.sessions);
    return {
      lesson,
      ...sides,
      failure: failure?.id ?? null,
      verdict: !enough
        ? "too-few"
        : betterVerified || fewerRecurrences
          ? "helps"
          : "no-better",
    };
  });
}

const blank = (): Side => ({ sessions: 0, verified: 0, recurred: 0 });

export function retirementFindings(effects: LessonEffect[]): Array<{
  line: string;
  sessions: number;
}> {
  return effects
    .filter((effect) => effect.verdict === "no-better")
    .map((effect) => ({
      line: `Lesson ${effect.lesson} does no better than without it (verified ${effect.with.verified}/${effect.with.sessions} vs ${effect.without.verified}/${effect.without.sessions}${effect.failure ? `; ${effect.failure} recurred ${effect.with.recurred}/${effect.with.sessions} vs ${effect.without.recurred}/${effect.without.sessions}` : ""}): retire it with \`ocean skill review ${effect.lesson} rejected\``,
      sessions: effect.with.sessions,
    }));
}
