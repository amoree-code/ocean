import { openSessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";
import {
  failureRecurrence,
  ladderFindings,
  listFailures,
} from "@ocean/services/journey/failures.js";
import {
  lessonEffects,
  retirementFindings,
} from "@ocean/services/journey/lesson-effect.js";
import {
  analyzeSessions,
  proposeTelemetry,
  signatureStats,
} from "@ocean/services/journey/telemetry.js";

// `ocean telemetry [--days N] [--yes]` (T-314): recurring errors and failing providers in the
// last N days (30) of sessions, proposed as backlog lines for review; a dry run until --yes.
// T-323: each error carries its signature; one that already has a failure record is tracked
// there instead, an absorbed one that came back proposes a guardrail climb, and a lesson that
// does no better than without it is proposed for retirement.
export async function runTelemetryCommand(args: string[]): Promise<void> {
  const at = args.indexOf("--days");
  const days = at >= 0 ? Number(args[at + 1]) : 30;
  if (!(days > 0)) throw new Error("Usage: ocean telemetry [--days N] [--yes]");
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const store = await openSessionStore();
  try {
    const sessions = store.list();
    // Three passes read the same sessions; each is read from the store once.
    const cache = new Map<string, ReturnType<typeof store.listEvents>>();
    const eventsOf = (id: string) => {
      const events = cache.get(id) ?? store.listEvents(id);
      cache.set(id, events);
      return events;
    };
    const records = await listFailures();
    const tracked = new Set(records.map((record) => record.signature));
    const recurrence = failureRecurrence(
      records,
      signatureStats(sessions, eventsOf, ""),
    );
    const findings = [
      ...analyzeSessions(sessions, eventsOf, since).filter(
        (finding) => !finding.signature || !tracked.has(finding.signature),
      ),
      ...ladderFindings(recurrence),
      ...retirementFindings(lessonEffects(sessions, eventsOf, since, records)),
    ];
    const result = await proposeTelemetry(findings, args.includes("--yes"));
    console.log(
      JSON.stringify(
        { findings, failures: recurrence, proposed: result },
        null,
        2,
      ),
    );
    if (!args.includes("--yes"))
      console.error("Dry run: pass --yes to propose them as backlog lines.");
  } finally {
    store.close();
  }
}
