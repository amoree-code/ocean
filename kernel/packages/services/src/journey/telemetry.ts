import { proposeMemory } from "@ocean/brain/memory/memory-write.js";
import { MemoryContractError } from "@ocean/core/domain/mcp/memory-contract.js";
import type {
  Session,
  SessionEvent,
} from "@ocean/core/domain/sessions/session.js";

// Session telemetry (T-314): what keeps going wrong in Ocean's own sessions becomes a proposed
// backlog line for the owner — never a task, never applied without review. Read from the session
// store: an error seen in at least MIN_REPEATS sessions, and providers whose sessions fail or are
// left unfinished.

const MIN_REPEATS = 3;
const ERROR_TYPES = new Set(["error", "provider_blocked", "closeout_warning"]);

// The same failure with different ids, paths or numbers counts as one.
export function errorShape(text: string): string {
  return text
    .replace(/\/[^\s:'"]+/g, "<path>")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<id>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export type TelemetryFinding = { line: string; sessions: number };

export function analyzeSessions(
  sessions: Session[],
  eventsOf: (sessionId: string) => SessionEvent[],
  sinceIso: string,
): TelemetryFinding[] {
  const recent = sessions.filter((session) => session.createdAt >= sinceIso);
  const errors = new Map<string, Set<string>>();
  for (const session of recent)
    for (const event of eventsOf(session.sessionId)) {
      if (!ERROR_TYPES.has(event.type)) continue;
      const shape = errorShape(event.data);
      if (!shape) continue;
      const seen = errors.get(shape) ?? new Set<string>();
      seen.add(session.sessionId);
      errors.set(shape, seen);
    }
  const findings: TelemetryFinding[] = [...errors]
    .filter(([, ids]) => ids.size >= MIN_REPEATS)
    .sort((a, b) => b[1].size - a[1].size)
    .map(([shape, ids]) => ({
      line: `Recurring error in ${ids.size} sessions: ${shape}`,
      sessions: ids.size,
    }));
  const byProvider = new Map<string, { failed: number; total: number }>();
  for (const session of recent) {
    const entry = byProvider.get(session.provider) ?? { failed: 0, total: 0 };
    entry.total++;
    if (session.status === "failed" || session.status === "running")
      entry.failed++;
    byProvider.set(session.provider, entry);
  }
  for (const [provider, { failed, total }] of byProvider)
    if (failed >= MIN_REPEATS && failed / total >= 0.25)
      findings.push({
        line: `${provider}: ${failed} of ${total} sessions failed or never finished`,
        sessions: failed,
      });
  return findings;
}

export async function proposeTelemetry(
  findings: TelemetryFinding[],
  apply: boolean,
): Promise<string[]> {
  if (!apply) return findings.map((finding) => finding.line);
  const proposed: string[] = [];
  for (const finding of findings)
    try {
      const { candidate } = await proposeMemory({
        content: finding.line,
        origin: "inferred",
        source: "session-telemetry",
        reason: "seen repeatedly in Ocean's own sessions",
        meta: { kind: "todo", project: "ocean" },
      });
      proposed.push(candidate);
    } catch (error) {
      if (!(error instanceof MemoryContractError)) throw error;
    }
  return proposed;
}
