import { openSessionStoreReadOnly } from "@ocean/loop/infrastructure/persistence/session-store.js";
import type { WeekFailure } from "@ocean/services/distill/patterns.js";
import { listFailures } from "@ocean/services/journey/failures.js";
import { signatureStats } from "@ocean/services/journey/telemetry.js";

// Telemetry signatures seen in a week's sessions, named by their failure record when one exists
// (T-329 phase 5). No session store (a fresh install, a test) is no failures, never a failed digest.
export async function weekFailures(week: {
  from: string;
  to: string;
}): Promise<WeekFailure[]> {
  let store: Awaited<ReturnType<typeof openSessionStoreReadOnly>>;
  try {
    store = await openSessionStoreReadOnly();
  } catch {
    return [];
  }
  try {
    const names = new Map(
      (await listFailures().catch(() => [])).map((record) => [
        record.signature,
        record.id,
      ]),
    );
    const stats = signatureStats(
      store.list(),
      (session) => store.listEvents(session),
      `${week.from}T00:00:00.000Z`,
    );
    const end = `${week.to}T23:59:59.999Z`;
    return [...stats].map(([signature, item]) => ({
      label: names.get(signature) ?? signature,
      sessions: new Set(
        item.hits
          .filter((hit) => hit.at >= week.from && hit.at <= end)
          .map((hit) => hit.sessionId),
      ).size,
    }));
  } finally {
    store.close();
  }
}
