import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, parseFrontmatter } from "@ocean/core/shared/fs-utils.js";
import {
  KNOWLEDGE_DIR,
  listProjectDirs,
  oceanPath,
  REPORTS_DIR,
  SYSTEM_DIR,
} from "@ocean/core/shared/paths.js";
import { sessionTokens } from "@ocean/loop/runs/session-tokens.js";
import {
  type FailureRecurrence,
  RECURRENCE_WINDOW_DAYS,
} from "../journey/failures.js";

// Moved to the loop package (T-322) so run guards can count tokens; re-exported for callers.
export { sessionTokens };

// `ocean scorecard` (T-318): Ocean's health as numbers read from real data, the baseline every
// improvement task (T-319–T-323) must move. Read-only, except the dated copy `--write` saves.
// A row whose data source does not exist yet says `n/a` and names the task that adds it — never a
// made-up zero.

export type ScorecardRow = {
  id: string;
  label: string;
  value: string;
  n?: number;
  of?: number;
  source: string;
  // The task that will give this row a data source, when it has none yet.
  pendingTask?: string;
};

export type ScorecardInput = {
  // `ocean doctor` client findings for installed clients.
  clients: Array<{ code: string }>;
  sessions: Array<{ verificationStatus: string; taskId: string | null }>;
  memoryAudit: Array<{ action: string; source: string }>;
  writers: WriterLookup;
  // Frontmatter of every live task.
  tasks: Array<Record<string, string>>;
  // What a client's brain_search gets: the mode a probe search ran in, as the MCP server runs it
  // (vectors only when the index has them and the local embedder answers), and why not hybrid.
  search:
    | { built: false }
    | { built: true; mode: "hybrid" | "fts"; stale: boolean; vector: string };
  // The last `ocean brain eval` result; none exists until T-321.
  searchEval: { hitAt5: number; at: string } | null;
  schedules: Array<{ enabled: boolean }>;
  // Frontmatter of every lesson file.
  lessons: Array<Record<string, string>>;
  // Ids of lessons a `lesson_applied` event names, across all sessions (T-323).
  lessonsApplied: string[];
  // Recurrence of every failure record's signature (T-323).
  failures: FailureRecurrence[];
  // Sessions whose provider reported token usage, and their tokens.
  tokens: { sessions: number; reporting: number; total: number };
  // The latest monthly `ocean memory hygiene` counts (T-322).
  hygiene: {
    month: string;
    records: number;
    verified: number;
    drifted: number;
    unverifiable: number;
  } | null;
  // The last nightly drift check: records changed with no audited write (T-322, F6).
  drift: { records: number; unrecorded: number; since: string | null } | null;
};

const percent = (n: number, of: number) =>
  of ? `${Math.round((n / of) * 1000) / 10}%` : "n/a";

function ratio(
  id: string,
  label: string,
  n: number,
  of: number,
  source: string,
): ScorecardRow {
  return {
    id,
    label,
    value: `${n} of ${of} (${percent(n, of)})`,
    n,
    of,
    source,
  };
}

const notYet = (
  id: string,
  label: string,
  source: string,
  pendingTask: string,
  why = "no data source yet",
): ScorecardRow => ({
  id,
  label,
  value: `n/a — ${why} (${pendingTask})`,
  source,
  pendingTask,
});

// Installed clients Ocean can wire. The engine-location warning is about the machine, and an
// unsupported client (no MCP) can never count as working, so neither is in the total.
const NOT_A_CLIENT = new Set(["CLIENT_ENGINE_TEMPORARY", "CLIENT_UNSUPPORTED"]);

export function clientsRow(clients: ScorecardInput["clients"]): ScorecardRow {
  const installed = clients.filter(
    (finding) => !NOT_A_CLIENT.has(finding.code),
  );
  const working = installed.filter(
    (finding) => finding.code === "CLIENT_WIRED",
  ).length;
  // From a temporary build every plan points at that build, so no client reads as wired.
  const temporary = clients.some(
    (finding) => finding.code === "CLIENT_ENGINE_TEMPORARY",
  );
  return {
    id: "clients",
    label: "Clients confirmed working",
    value: `${working} of ${installed.length}${temporary ? " (temporary engine: run the installed ocean)" : ""}`,
    n: working,
    of: installed.length,
    source: "ocean doctor (client findings)",
  };
}

// "proven" is the only verified state the session store has.
export const sessionsVerifiedRow = (sessions: ScorecardInput["sessions"]) =>
  ratio(
    "sessions-verified",
    "Sessions verified",
    sessions.filter((session) => session.verificationStatus === "proven")
      .length,
    sessions.length,
    "sessions.sqlite verification_status",
  );

export const sessionsWithTaskRow = (sessions: ScorecardInput["sessions"]) =>
  ratio(
    "sessions-task",
    "Sessions with a task",
    sessions.filter((session) => Boolean(session.taskId?.trim())).length,
    sessions.length,
    "sessions.sqlite task_id",
  );

// Every audit action that changes or proposes a record; owner approve/reject are reviews.
const WRITE_ACTIONS = new Set([
  "create",
  "update",
  "delete",
  "restore",
  "propose",
]);

// Who a write's audit `source` names. A client is an MCP client name or client id the collector
// knows (`clients`), or a `session:<id>` the session store can trace to a provider
// (`session:desktop:<id>` is Claude Desktop's chat). The owner and Ocean's own jobs — review,
// the CLI, distill, telemetry, the harvest of hand-written instruction files — are not clients
// and are left out of the percentage. Anything else (`unknown`, a test name, an untraceable
// session) is a write with no known client.
export type WriterLookup = {
  clients: ReadonlySet<string>;
  sessionProvider: (sessionId: string) => string | null;
};

const OWNER_OR_OCEAN = new Set([
  "owner-review",
  "cli",
  "instructions",
  "session-telemetry",
  "hygiene",
  "curator",
]);

export function writerOf(
  source: string | undefined,
  lookup: WriterLookup,
): "client" | "owner-or-ocean" | "unknown" {
  const name = source?.trim() ?? "";
  if (!name || name === "unknown") return "unknown";
  if (OWNER_OR_OCEAN.has(name) || name.startsWith("distill:"))
    return "owner-or-ocean";
  if (lookup.clients.has(name)) return "client";
  if (name.startsWith("session:desktop:")) return "client";
  if (name.startsWith("session:"))
    return lookup.sessionProvider(name.slice("session:".length))
      ? "client"
      : "unknown";
  return "unknown";
}

export function memoryWritesRow(
  audit: ScorecardInput["memoryAudit"],
  lookup: WriterLookup,
): ScorecardRow {
  const writes = audit.filter((entry) => WRITE_ACTIONS.has(entry.action));
  const kinds = writes.map((entry) => writerOf(entry.source, lookup));
  const known = kinds.filter((kind) => kind === "client").length;
  const own = kinds.filter((kind) => kind === "owner-or-ocean").length;
  const row = ratio(
    "memory-writes",
    "Memory writes with a known client",
    known,
    writes.length - own,
    "memory audit log source",
  );
  return own
    ? {
        ...row,
        value: `${row.value}; ${own} more by the owner or Ocean's own jobs`,
      }
    : row;
}

// T-320 adds `verify:` / `verified:` to task frontmatter; until then every task counts as none.
export const tasksVerifiedRow = (tasks: ScorecardInput["tasks"]) =>
  ratio(
    "tasks-verify",
    "Tasks with verify evidence",
    tasks.filter((fields) => Boolean(fields.verify || fields.verified)).length,
    tasks.length,
    "task frontmatter verify / verified",
  );

export function searchRows(
  search: ScorecardInput["search"],
  searchEval: ScorecardInput["searchEval"],
): ScorecardRow[] {
  const mode = !search.built
    ? "no index"
    : [
        search.mode,
        search.stale ? "index stale" : "",
        search.mode === "fts" ? `vectors ${search.vector}` : "",
      ]
        .filter(Boolean)
        .join("; ");
  return [
    {
      id: "search-mode",
      label: "Search mode",
      value: mode,
      source: "probe brain_search, as over MCP",
    },
    searchEval
      ? {
          id: "search-eval",
          label: "Search hit@5 (last eval)",
          value: `${percent(searchEval.hitAt5, 1)} on ${searchEval.at.slice(0, 10)}`,
          source: "ocean upkeep (memory eval)",
        }
      : notYet(
          "search-eval",
          "Search hit@5 (last eval)",
          "ocean upkeep (memory eval)",
          "T-322",
          "no eval run yet",
        ),
  ];
}

export function schedulesRow(
  schedules: ScorecardInput["schedules"],
): ScorecardRow {
  const enabled = schedules.filter((schedule) => schedule.enabled).length;
  return {
    id: "schedules",
    label: "Scheduled jobs (enabled)",
    value: `${enabled} of ${schedules.length}`,
    n: enabled,
    of: schedules.length,
    source: "ocean schedule list",
  };
}

// "Used" counts lessons injected into at least one run (`lesson_applied`, T-323).
export function lessonsRows(
  lessons: ScorecardInput["lessons"],
  applied: ScorecardInput["lessonsApplied"] = [],
): ScorecardRow[] {
  const active = lessons.filter((fields) => fields.status === "active").length;
  const used = new Set(applied);
  return [
    {
      id: "lessons-active",
      label: "Lessons active",
      value: `${active} of ${lessons.length}`,
      n: active,
      of: lessons.length,
      source: "05-knowledge/lessons status",
    },
    ratio(
      "lessons-used",
      "Lessons used",
      lessons.filter((fields) => used.has(fields.id)).length,
      lessons.length,
      "lesson_applied events",
    ),
  ];
}

// Recurrence per failure signature (T-323): one summary row, then one row per failure record.
export function failuresRows(
  failures: ScorecardInput["failures"],
): ScorecardRow[] {
  const zero = failures.filter(
    (entry) =>
      entry.status === "absorbed" &&
      entry.recent === 0 &&
      (entry.cleanDays ?? 0) >= RECURRENCE_WINDOW_DAYS,
  ).length;
  return [
    {
      id: "failures-zero",
      label: `Failures at zero ${RECURRENCE_WINDOW_DAYS}+ days`,
      value: `${zero} of ${failures.length}`,
      n: zero,
      of: failures.length,
      source: "05-knowledge/failures + session signatures",
    },
    ...failures.map((entry) => ({
      id: `failure:${entry.id}`,
      label: `  ${entry.id}`,
      value: `${entry.status}, rung ${entry.rung}: ${entry.recent} sessions in ${RECURRENCE_WINDOW_DAYS} d${entry.cleanDays === null ? "" : `, clean ${entry.cleanDays} d`}`,
      n: entry.recent,
      source: `signature ${entry.signature}`,
    })),
  ];
}

export function tokensRow(tokens: ScorecardInput["tokens"]): ScorecardRow {
  // Not a missing feature: the providers that were run simply did not report usage.
  if (!tokens.reporting)
    return {
      id: "tokens",
      label: "Tokens per session",
      value: "n/a — no captured session reports usage",
      source: "session events (provider usage)",
    };
  return {
    id: "tokens",
    label: "Tokens per session",
    value: `${Math.round(tokens.total / tokens.reporting).toLocaleString("en-US")} avg over ${tokens.reporting} of ${tokens.sessions} sessions that report usage`,
    n: tokens.reporting,
    of: tokens.sessions,
    source: "session events (provider usage)",
  };
}

export const hygieneRow = (hygiene: ScorecardInput["hygiene"]): ScorecardRow =>
  hygiene
    ? {
        id: "hygiene",
        label: "Records verified / drifted / unverifiable",
        value: `${hygiene.verified} / ${hygiene.drifted} / ${hygiene.unverifiable} of ${hygiene.records} with claims (${hygiene.month})`,
        n: hygiene.verified,
        of: hygiene.records,
        source: "ocean memory hygiene",
      }
    : notYet(
        "hygiene",
        "Records verified / drifted / unverifiable",
        "ocean memory hygiene",
        "T-322",
        "no hygiene run yet",
      );

export const driftRow = (drift: ScorecardInput["drift"]): ScorecardRow =>
  drift?.since
    ? {
        id: "drift",
        label: "Records changed with no recorded write",
        value: `${drift.unrecorded} of ${drift.records} since ${drift.since.slice(0, 10)}`,
        n: drift.unrecorded,
        of: drift.records,
        source: "ocean memory drift (hash vs audit log)",
      }
    : notYet(
        "drift",
        "Records changed with no recorded write",
        "ocean memory drift (hash vs audit log)",
        "T-322",
        "no snapshot to compare yet",
      );

export function scorecardRows(input: ScorecardInput): ScorecardRow[] {
  return [
    clientsRow(input.clients),
    sessionsVerifiedRow(input.sessions),
    sessionsWithTaskRow(input.sessions),
    memoryWritesRow(input.memoryAudit, input.writers),
    tasksVerifiedRow(input.tasks),
    ...searchRows(input.search, input.searchEval),
    schedulesRow(input.schedules),
    ...lessonsRows(input.lessons, input.lessonsApplied),
    ...failuresRows(input.failures),
    tokensRow(input.tokens),
    hygieneRow(input.hygiene),
    driftRow(input.drift),
  ];
}

export function renderTable(rows: ScorecardRow[]): string {
  const width = Math.max(...rows.map((row) => row.label.length));
  return rows
    .map((row) => `${row.label.padEnd(width)}  ${row.value}`)
    .join("\n");
}

export function renderMarkdown(rows: ScorecardRow[], date: string): string {
  const cell = (text: string) => text.replace(/\|/g, "\\|");
  return [
    "---",
    "type: scorecard",
    `date: ${date}`,
    "---",
    "",
    `# Ocean scorecard — ${date}`,
    "",
    "| Measure | Value | Source |",
    "|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${cell(row.label)} | ${cell(row.value)} | ${cell(row.source)} |`,
    ),
    "",
  ].join("\n");
}

// The last nightly search eval (T-322): `ocean upkeep` saves it, the scorecard reads it.
export const searchEvalFile = () =>
  oceanPath(SYSTEM_DIR, "state", "search-eval.json");

export async function readSearchEval(): Promise<ScorecardInput["searchEval"]> {
  try {
    const saved = JSON.parse(await readFile(searchEvalFile(), "utf8"));
    return typeof saved.hitAt5 === "number" && typeof saved.at === "string"
      ? { hitAt5: saved.hitAt5, at: saved.at }
      : null;
  } catch {
    return null;
  }
}

export function scorecardFile(date: string): string {
  return oceanPath(REPORTS_DIR, "scorecard", `${date}.md`);
}

export async function writeScorecard(
  rows: ScorecardRow[],
  date: string,
): Promise<string> {
  const file = scorecardFile(date);
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, renderMarkdown(rows, date));
  return file;
}

async function frontmatterOf(dir: string, name: string) {
  try {
    return parseFrontmatter(await readFile(path.join(dir, name), "utf8"));
  } catch {
    return null;
  }
}

// Every live task in every project (archive/ excluded), as its frontmatter.
export async function readTaskFrontmatter(): Promise<
  Array<Record<string, string>>
> {
  const tasks: Array<Record<string, string>> = [];
  for (const { dir } of listProjectDirs()) {
    const root = oceanPath(dir, "tasks");
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (entry === "archive") continue;
      const fields = await frontmatterOf(path.join(root, entry), "task.md");
      if (fields) tasks.push(fields);
    }
  }
  return tasks;
}

// Every lesson file, as its frontmatter; archive/ and CONFLICTS.md are not lessons.
export async function readLessonFrontmatter(): Promise<
  Array<Record<string, string>>
> {
  const dir = oceanPath(KNOWLEDGE_DIR, "lessons");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const lessons: Array<Record<string, string>> = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".md") || name === "CONFLICTS.md") continue;
    const fields = await frontmatterOf(dir, name);
    if (fields) lessons.push(fields);
  }
  return lessons;
}
