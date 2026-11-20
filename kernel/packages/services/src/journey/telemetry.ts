import { createHash } from "node:crypto";
import { proposeMemory } from "@ocean/brain/memory/memory-write.js";
import { MemoryContractError } from "@ocean/core/domain/mcp/memory-contract.js";
import type {
  Session,
  SessionEvent,
} from "@ocean/core/domain/sessions/session.js";

// Session telemetry (T-314): what keeps going wrong in Ocean's own sessions becomes a proposed
// backlog line for the owner — never a task, never applied without review. Read from the session
// store: an error seen in at least MIN_REPEATS sessions, and providers whose sessions fail or are
// left unfinished. T-323 names each error by a signature so a failure record can track it.

const MIN_REPEATS = 3;
const STUCK_AFTER_MS = 6 * 60 * 60 * 1000;
// The event type says which step failed; the signature names that step.
const COMMAND_OF: Record<string, string> = {
  error: "run",
  provider_blocked: "provider",
  closeout_warning: "closeout",
};

export const isFailureEvent = (type: string) => type in COMMAND_OF;

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

// What kind of error, without the message: a zod issue code, a Node errno, or an Error's name.
export function errorClass(text: string): string {
  return (
    /"code"\s*:\s*"([a-z_]+)"/.exec(text)?.[1] ??
    /\b(E[A-Z]{3,})\b/.exec(text)?.[1] ??
    /\b([A-Z][A-Za-z]*Error)\b/.exec(text)?.[1] ??
    "error"
  );
}

// `<command>/<error class>/<hash of the shape>`: stable across ids, paths and numbers, short
// enough to name a failure record by.
export function failureSignature(
  eventType: string,
  text: string,
): string | null {
  const command = COMMAND_OF[eventType];
  const shape = errorShape(text);
  if (!command || !shape) return null;
  const hash = createHash("sha256").update(shape).digest("hex").slice(0, 8);
  return `${command}/${errorClass(text)}/${hash}`;
}

export type SignatureStats = {
  shape: string;
  sessions: Set<string>;
  // Every occurrence, so a caller can count the sessions after a given moment.
  hits: Array<{ sessionId: string; at: string }>;
  firstSeen: string;
  lastSeen: string;
};

// Every signature seen since `sinceIso`, with the sessions it appeared in, however rare.
export function signatureStats(
  sessions: Session[],
  eventsOf: (sessionId: string) => SessionEvent[],
  sinceIso: string,
): Map<string, SignatureStats> {
  const stats = new Map<string, SignatureStats>();
  for (const session of sessions) {
    if (session.createdAt < sinceIso) continue;
    for (const event of eventsOf(session.sessionId)) {
      const signature = failureSignature(event.type, event.data);
      if (!signature) continue;
      const at = event.createdAt ?? session.createdAt;
      const entry = stats.get(signature) ?? {
        shape: errorShape(event.data),
        sessions: new Set<string>(),
        hits: [],
        firstSeen: at,
        lastSeen: at,
      };
      entry.sessions.add(session.sessionId);
      entry.hits.push({ sessionId: session.sessionId, at });
      if (at < entry.firstSeen) entry.firstSeen = at;
      if (at > entry.lastSeen) entry.lastSeen = at;
      stats.set(signature, entry);
    }
  }
  return stats;
}

export type TelemetryFinding = {
  line: string;
  sessions: number;
  signature?: string;
};

export function analyzeSessions(
  sessions: Session[],
  eventsOf: (sessionId: string) => SessionEvent[],
  sinceIso: string,
  now = Date.now(),
): TelemetryFinding[] {
  const recent = sessions.filter((session) => session.createdAt >= sinceIso);
  const findings: TelemetryFinding[] = [
    ...signatureStats(recent, eventsOf, sinceIso),
  ]
    .filter(([, stats]) => stats.sessions.size >= MIN_REPEATS)
    .sort((a, b) => b[1].sessions.size - a[1].sessions.size)
    .map(([signature, stats]) => ({
      line: `Recurring error in ${stats.sessions.size} sessions [${signature}]: ${stats.shape}`,
      sessions: stats.sessions.size,
      signature,
    }));
  const byProvider = new Map<string, { failed: number; total: number }>();
  for (const session of recent) {
    const entry = byProvider.get(session.provider) ?? { failed: 0, total: 0 };
    entry.total++;
    // A running session counts only once it has run longer than any real session would.
    const stuck =
      session.status === "running" &&
      now - Date.parse(session.createdAt) > STUCK_AFTER_MS;
    if (session.status === "failed" || stuck) entry.failed++;
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
