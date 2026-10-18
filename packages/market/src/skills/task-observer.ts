import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  SessionStoreFactory,
  SessionStorePort,
} from "@ocean/core/domain/ports/session-store-port.js";
import { redactRuntimeText } from "@ocean/core/domain/redaction/redaction.js";
import type { SessionEvent } from "@ocean/core/domain/sessions/session.js";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { addSkillCandidate } from "./skill-curation.js";

export type ObservationStatus =
  | "observed"
  | "candidate"
  | "approved"
  | "promoted"
  | "discarded"
  | "rejected";
export type TaskObservation = {
  observationId: string;
  sourceSessionId: string;
  taskId: string | null;
  profileId: string;
  signalType:
    | "repeated-correction"
    | "repeated-procedure"
    | "explicit-decision";
  summary: string;
  evidenceRefs: string[];
  confidence: number;
  status: ObservationStatus;
  createdAt: string;
  reviewedAt: string | null;
  skillCandidateId: string | null;
};

const observationsFile = () =>
  oceanPath(SYSTEM_DIR, "skills", "observations.json");

async function load(): Promise<TaskObservation[]> {
  try {
    return JSON.parse(
      await readFile(observationsFile(), "utf8"),
    ) as TaskObservation[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function save(items: TaskObservation[]): Promise<void> {
  await mkdir(path.dirname(observationsFile()), { recursive: true });
  await writeFile(
    observationsFile(),
    `${JSON.stringify(items.slice(-200), null, 2)}\n`,
    { mode: 0o600 },
  );
}

function observationId(
  sessionId: string,
  signalType: string,
  summary: string,
): string {
  return `obs-${createHash("sha256").update(`${sessionId}:${signalType}:${summary}`).digest("hex").slice(0, 16)}`;
}

export type SessionSignal = {
  signalType: TaskObservation["signalType"];
  summary: string;
  refs: string[];
  confidence: number;
};

const CORRECTION_PATTERN =
  /\bno,|\bactually,|\bnot that\b|\binstead of\b|\bshould use\b|\bthat'?s wrong\b/i;

function userInputTexts(events: SessionEvent[]) {
  return events
    .filter((event) => event.type === "user_input")
    .map((event) => ({
      id: event.eventId,
      text: redactRuntimeText(event.data).replace(/\s+/g, " ").trim(),
    }))
    .filter((event) => event.text.length > 12)
    .slice(0, 80);
}

// True when the user pushed back in this session ("no, use X", "that's wrong").
export function hasUserCorrection(events: SessionEvent[]): boolean {
  return userInputTexts(events).some((event) =>
    CORRECTION_PATTERN.test(event.text),
  );
}

// What a completed, proven session is worth remembering. Pure: reads events, writes nothing.
export function detectSessionSignals(events: SessionEvent[]): SessionSignal[] {
  const proven = events.filter(
    (event) =>
      event.type === "evidence" && /"result"\s*:\s*"proven"/.test(event.data),
  );
  if (!proven.length) return [];
  const outputs = events
    .filter((event) => ["provider_output", "text", "json"].includes(event.type))
    .map((event) => ({
      id: event.eventId,
      text: redactRuntimeText(event.data).replace(/\s+/g, " ").trim(),
    }))
    .filter((event) => event.text.length > 12)
    .slice(0, 80);
  const userInputs = userInputTexts(events);
  const candidates: SessionSignal[] = [];
  const decisions = outputs.filter((event) =>
    /\bdecision\s*:/i.test(event.text),
  );
  if (decisions.length)
    candidates.push({
      signalType: "explicit-decision",
      summary: decisions[0].text.slice(0, 500),
      refs: decisions.slice(0, 4).map((event) => `event:${event.id}`),
      confidence: 0.9,
    });
  const counts = new Map<string, { count: number; refs: string[] }>();
  for (const event of outputs) {
    const normalized = event.text.toLocaleLowerCase();
    const current = counts.get(normalized) ?? { count: 0, refs: [] };
    current.count += 1;
    current.refs.push(`event:${event.id}`);
    counts.set(normalized, current);
  }
  const repeated = [...counts.entries()].find(([, value]) => value.count >= 2);
  if (repeated)
    candidates.push({
      signalType: "repeated-procedure",
      summary: repeated[0].slice(0, 500),
      refs: repeated[1].refs.slice(0, 4),
      confidence: 0.8,
    });
  const corrections = userInputs.filter((event) =>
    CORRECTION_PATTERN.test(event.text),
  );
  if (corrections.length)
    candidates.push({
      signalType: "repeated-correction",
      summary: corrections[0].text.slice(0, 500),
      refs: corrections.slice(0, 4).map((event) => `event:${event.id}`),
      confidence: 0.7,
    });
  return candidates;
}

export async function observeSessionWithStore(
  store: SessionStorePort,
  sessionId: string,
): Promise<TaskObservation[]> {
  const session = store.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.status !== "completed") return [];
  const events = store.listEvents(sessionId);
  const candidates = detectSessionSignals(events);
  const items = await load();
  const created: TaskObservation[] = [];
  for (const candidate of candidates.slice(0, 4)) {
    const id = observationId(
      sessionId,
      candidate.signalType,
      candidate.summary,
    );
    if (items.some((item) => item.observationId === id)) continue;
    created.push({
      observationId: id,
      sourceSessionId: sessionId,
      taskId: session.taskId,
      profileId: session.profile,
      signalType: candidate.signalType,
      summary: candidate.summary,
      evidenceRefs: candidate.refs,
      confidence: candidate.confidence,
      status: "observed",
      createdAt: new Date().toISOString(),
      reviewedAt: null,
      skillCandidateId: null,
    });
  }
  if (created.length) await save([...items, ...created]);
  return created;
}

export async function observeSession(
  sessionId: string,
  openStore: SessionStoreFactory,
): Promise<TaskObservation[]> {
  const store = await openStore();
  try {
    return await observeSessionWithStore(store, sessionId);
  } finally {
    store.close();
  }
}

export async function listObservations(): Promise<TaskObservation[]> {
  return load();
}

/**
 * Approving an observation creates the skill candidate it was promising —
 * reviewObservation used to only flip a status flag with nothing downstream.
 * A duplicate or invalid candidate (see addSkillCandidate) leaves the
 * approval standing but skillCandidateId null; the summary is short and
 * redacted, so this should be rare.
 */
export async function reviewObservation(
  observationIdValue: string,
  status: Exclude<ObservationStatus, "observed" | "candidate">,
): Promise<TaskObservation> {
  const items = await load();
  const item = items.find(
    (candidate) => candidate.observationId === observationIdValue,
  );
  if (!item) throw new Error(`Observation not found: ${observationIdValue}`);
  item.status = status;
  item.reviewedAt = new Date().toISOString();
  if (status === "approved" && !item.skillCandidateId) {
    try {
      const candidate = await addSkillCandidate({
        id: `learned-${item.observationId.slice(4, 16)}`,
        name: `Learned: ${item.signalType} (${item.observationId.slice(4, 10)})`,
        instructions: item.summary,
        sourceSessionId: item.sourceSessionId,
      });
      item.skillCandidateId = candidate.id;
    } catch {
      // Duplicate id/name or invalid content — approval stands, no candidate.
    }
  }
  await save(items);
  return item;
}
