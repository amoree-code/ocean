import { openSessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";
import {
  analyzeSessions,
  proposeTelemetry,
} from "@ocean/services/journey/telemetry.js";

// `ocean telemetry [--days N] [--yes]` (T-314): recurring errors and failing providers in the
// last N days (30) of sessions, proposed as backlog lines for review; a dry run until --yes.
export async function runTelemetryCommand(args: string[]): Promise<void> {
  const at = args.indexOf("--days");
  const days = at >= 0 ? Number(args[at + 1]) : 30;
  if (!(days > 0)) throw new Error("Usage: ocean telemetry [--days N] [--yes]");
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const store = await openSessionStore();
  try {
    const findings = analyzeSessions(
      store.list(),
      (id) => store.listEvents(id),
      since,
    );
    const result = await proposeTelemetry(findings, args.includes("--yes"));
    console.log(JSON.stringify({ findings, proposed: result }, null, 2));
    if (!args.includes("--yes"))
      console.error("Dry run: pass --yes to propose them as backlog lines.");
  } finally {
    store.close();
  }
}
