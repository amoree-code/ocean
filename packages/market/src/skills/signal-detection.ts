import { redactRuntimeText } from "@ocean/core/domain/redaction/redaction.js";
import type { SessionEvent } from "@ocean/core/domain/sessions/session.js";

// What a session shows that is worth remembering (T-230). Pure: reads events, writes nothing.
export type SessionSignal = {
  signalType:
    | "repeated-correction"
    | "repeated-procedure"
    | "explicit-decision";
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
