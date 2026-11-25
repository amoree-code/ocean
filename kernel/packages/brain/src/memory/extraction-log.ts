import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { localDate } from "@ocean/core/shared/local-date.js";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";

// One line per extraction model call (T-335), so what session capture costs is visible:
// `ocean sessions cost` sums it per day and week. A transcript stretch already extracted is
// found here by its hash and never sent again; that skip is logged too, at no cost.

export type ExtractionOutcome = "ok" | "failed" | "repeat";

export type ExtractionLogEntry = {
  at: string;
  client: string;
  session: string;
  model: string;
  input_chars: number;
  ms: number;
  hash: string;
  outcome: ExtractionOutcome;
};

export function extractionLogFile(): string {
  return oceanPath(SYSTEM_DIR, "state", "extraction-log.jsonl");
}

const OUTCOMES = new Set<string>(["ok", "failed", "repeat"]);

function isEntry(value: unknown): value is ExtractionLogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.at === "string" &&
    typeof entry.hash === "string" &&
    typeof entry.input_chars === "number" &&
    typeof entry.ms === "number" &&
    OUTCOMES.has(entry.outcome as string)
  );
}

// Every readable line; a torn or foreign line is skipped, never fatal.
export async function readExtractionLog(): Promise<ExtractionLogEntry[]> {
  let text: string;
  try {
    text = await readFile(extractionLogFile(), "utf8");
  } catch {
    return [];
  }
  const entries: ExtractionLogEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isEntry(value)) entries.push(value);
    } catch {
      // skipped
    }
  }
  return entries;
}

export async function appendExtractionLog(
  entry: ExtractionLogEntry,
): Promise<void> {
  const file = extractionLogFile();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

// Whether these exact turns were already extracted with a readable answer.
export async function extractedBefore(hash: string): Promise<boolean> {
  return (await readExtractionLog()).some(
    (entry) => entry.hash === hash && entry.outcome === "ok",
  );
}

export type CostRow = {
  period: string;
  calls: number;
  failed: number;
  repeats: number;
  input_chars: number;
  // About four characters a token; an estimate, the client does not report tokens back.
  est_tokens: number;
  ms: number;
};

export type CostSummary = { days: CostRow[]; weeks: CostRow[] };

// The Monday that starts the local week a date falls in.
function weekOf(date: Date): string {
  const monday = new Date(date);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return localDate(monday);
}

const emptyRow = (period: string): CostRow => ({
  period,
  calls: 0,
  failed: 0,
  repeats: 0,
  input_chars: 0,
  est_tokens: 0,
  ms: 0,
});

function add(row: CostRow, entry: ExtractionLogEntry): void {
  if (entry.outcome === "repeat") {
    row.repeats += 1;
    return;
  }
  row.calls += 1;
  if (entry.outcome === "failed") row.failed += 1;
  row.input_chars += entry.input_chars;
  row.est_tokens = Math.ceil(row.input_chars / 4);
  row.ms += entry.ms;
}

// The last `days` local days and `weeks` local weeks, newest first, each listed even when empty.
export function summarizeCost(
  entries: ExtractionLogEntry[],
  options: { now?: Date; days?: number; weeks?: number } = {},
): CostSummary {
  const now = options.now ?? new Date();
  const days = new Map<string, CostRow>();
  for (let i = 0; i < (options.days ?? 7); i++) {
    const day = new Date(now);
    day.setDate(day.getDate() - i);
    days.set(localDate(day), emptyRow(localDate(day)));
  }
  const weeks = new Map<string, CostRow>();
  for (let i = 0; i < (options.weeks ?? 4); i++) {
    const week = new Date(now);
    week.setDate(week.getDate() - 7 * i);
    weeks.set(weekOf(week), emptyRow(weekOf(week)));
  }
  for (const entry of entries) {
    const at = new Date(entry.at);
    if (Number.isNaN(at.getTime())) continue;
    const day = days.get(localDate(at));
    if (day) add(day, entry);
    const week = weeks.get(weekOf(at));
    if (week) add(week, entry);
  }
  return { days: [...days.values()], weeks: [...weeks.values()] };
}
