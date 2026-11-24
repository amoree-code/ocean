import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { memoryDigest } from "@ocean/brain/memory/memory-digest.js";
import { atomicWrite, withFileLock } from "@ocean/core/shared/fs-utils.js";
import {
  DAILY_DIR,
  oceanPath,
  PERSONAL_DIR,
  REPORTS_DIR,
} from "@ocean/core/shared/paths.js";
import { listTasks } from "@ocean/loop/tasks/list-tasks.js";
import { buildBrief, type FetchText } from "../brief/brief.js";
import {
  keepTicks,
  loopKey,
  noteFile,
  noteRelative,
  putBlock,
  readBlock,
} from "./note.js";

// The morning half of the daily note (T-314), with no model: what to focus on (open tasks), what
// is coming (dated lines in the owner's records within 30 days), what was left open (unticked
// open loops from recent days), when he studies (his schedule), what waits on him, and the brief.
// Written between markers under the title; rerunning replaces only that block.

const DAY_MS = 24 * 60 * 60 * 1000;
const AHEAD_DAYS = 30;
// Loops carry for three mornings; older ones stay in their session records.
const LOOP_DAYS = 3;
const EVENT =
  /\b(exam|deadline|due|interview|meeting|appointment|call|submit|test)\b|موعد|امتحان|مقابلة/i;
const OPEN_STATES = new Set([
  "active",
  "in-qa",
  "in_progress",
  "blocked",
  "todo",
  "planned",
]);

export type DayPlan = {
  date: string;
  note: string;
  tasks: string[];
  deadlines: string[];
  loops: string[];
  schedule: string[];
  waiting: string[];
  activity: string[];
  brief: string[];
};

const days = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

async function markdownIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "archive") continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownIn(file)));
    else if (entry.name.endsWith(".md") && entry.name !== "CONFLICTS.md")
      files.push(file);
  }
  return files.sort();
}

const relative = (file: string) =>
  path.relative(oceanPath(), file).split(path.sep).join("/");

// Lines in the owner's records that name a date between today and 30 days ahead: exams,
// deadlines, appointments. Frontmatter dates (created, updated) are not events.
export async function upcoming(date: string): Promise<string[]> {
  const found: { at: string; line: string }[] = [];
  for (const file of await markdownIn(oceanPath(PERSONAL_DIR))) {
    const text = (await readFile(file, "utf8")).replace(/\r\n/g, "\n");
    const body = text.startsWith("---\n")
      ? text.slice(text.indexOf("\n---", 3) + 4)
      : text;
    for (const raw of body.split("\n")) {
      const line = raw
        .replace(/^[\s>|*-]+/, "")
        .replace(/\|/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      for (const match of line.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) {
        const at = match[1];
        if (Number.isNaN(Date.parse(at))) continue;
        const ahead = days(date, at);
        if (ahead < 0 || ahead > AHEAD_DAYS) continue;
        // Today's date in a record is usually when it was written; only an event line counts.
        if (ahead === 0 && !EVENT.test(line)) continue;
        const label =
          ahead === 0 ? "today" : ahead === 1 ? "tomorrow" : `in ${ahead} days`;
        found.push({
          at,
          line: `${at} (${label}) — ${line.slice(0, 140)} ([${path.basename(file, ".md")}](../${relative(file)}))`,
        });
      }
    }
  }
  const seen = new Set<string>();
  return found
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((item) => item.line)
    .filter((line) => !seen.has(line) && seen.add(line))
    .slice(0, 8);
}

// Unticked open loops from the last three days of notes, oldest first; ticking one in any note
// (`- [x]`) closes it everywhere.
export async function openLoops(date: string): Promise<string[]> {
  const notes: { day: string; text: string }[] = [];
  for (const name of await readdir(oceanPath(DAILY_DIR)).catch(
    () => [] as string[],
  )) {
    const day = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(name)?.[1];
    if (!day || day >= date || days(day, date) > LOOP_DAYS) continue;
    notes.push({
      day,
      text: await readFile(oceanPath(DAILY_DIR, name), "utf8"),
    });
  }
  notes.sort((a, b) => a.day.localeCompare(b.day));
  const closed = new Set<string>();
  const open = new Map<string, string>();
  for (const { day, text } of notes)
    for (const line of text.split("\n")) {
      if (/^- \[[xX]\] /.test(line)) closed.add(loopKey(line));
      else if (/^- \[ \] /.test(line)) {
        const key = loopKey(line);
        if (!open.has(key))
          open.set(
            key,
            /_\(from \d{4}-\d{2}-\d{2}\)_$/.test(line)
              ? line
              : `${line} _(from ${day})_`,
          );
      }
    }
  return [...open]
    .filter(([key]) => !closed.has(key))
    .map(([, line]) => line)
    .slice(0, 10);
}

async function schedule(): Promise<string[]> {
  const lines: string[] = [];
  for (const file of await markdownIn(oceanPath(PERSONAL_DIR, "schedule")))
    for (const line of (await readFile(file, "utf8")).split("\n"))
      if (/^- /.test(line)) lines.push(line);
  return lines.slice(0, 5);
}

// One ledger row as the day note needs it; the interfaces pass the MCP call ledger in.
export type ClientCall = { ts: string; client: string; tool: string };

const WRITE_TOOLS = new Set([
  "memory_write",
  "memory_propose",
  "memory_delete",
  "memory_restore",
  "ocean_handoff_create",
  "ocean_session_promote",
]);
// Ledger bookkeeping rows, not a model using a tool.
const NOT_A_USE = new Set(["context_ack", "unknown"]);

// The day before `date` on the local clock: which clients read Ocean and which wrote to it
// (T-328). One line, from the ledger's names only — never what was read or written.
export function oceanActivity(calls: ClientCall[], date: string): string {
  const start = new Date(`${date}T00:00:00`);
  const from = new Date(start);
  from.setDate(from.getDate() - 1);
  const counts = new Map<string, { reads: number; writes: number }>();
  for (const call of calls) {
    const at = Date.parse(call.ts);
    if (!(at >= from.getTime() && at < start.getTime())) continue;
    if (NOT_A_USE.has(call.tool)) continue;
    const row = counts.get(call.client) ?? { reads: 0, writes: 0 };
    if (WRITE_TOOLS.has(call.tool)) row.writes += 1;
    else row.reads += 1;
    counts.set(call.client, row);
  }
  if (!counts.size) return "- No client used Ocean yesterday.";
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts = [...counts.entries()]
    .sort((a, b) => b[1].reads + b[1].writes - (a[1].reads + a[1].writes))
    .map(
      ([client, { reads, writes }]) =>
        `${client} ${[reads ? plural(reads, "read") : "", writes ? plural(writes, "write") : ""].filter(Boolean).join(", ")}`,
    );
  return `- Yesterday: ${parts.join(" · ")}`;
}

const section = (title: string, lines: string[], empty?: string) =>
  lines.length || empty
    ? ["", `### ${title}`, "", ...(lines.length ? lines : [`- ${empty}`])]
    : [];

export async function prepareDay(options: {
  date: string;
  apply: boolean;
  fetchText?: FetchText;
  news?: string;
  // The MCP call ledger; without it the note has no Ocean line.
  calls?: () => Promise<ClientCall[]>;
}): Promise<DayPlan> {
  const { date } = options;
  const tasks = (await listTasks())
    .filter((task) => OPEN_STATES.has(task.state))
    .map((task) => {
      const title = task.title.replace(/\s+/g, " ").split(/[:—]/)[0].trim();
      return `- ${task.id} — ${title.slice(0, 90)}${task.state === "blocked" ? " (blocked)" : ""}`;
    });
  const deadlines = (await upcoming(date)).map((line) => `- ${line}`);
  const loops = await openLoops(date);
  const hours = await schedule();
  const activity = options.calls
    ? [oceanActivity(await options.calls().catch(() => []), date)]
    : [];
  const waiting = (await memoryDigest({ stale: null })).map(
    (line) => `- ${line}`,
  );
  const brief = await buildBrief({
    date,
    dryRun: !options.apply,
    fetchText: options.fetchText,
  }).catch(() => null);
  // Items already in today's brief (an earlier run marked them seen) still lead the morning.
  const briefFile = oceanPath(REPORTS_DIR, "briefs", `${date}.md`);
  const earlier = (await readFile(briefFile, "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line.startsWith("- **"));
  const fresh = (brief?.items ?? []).map(
    (item) =>
      `- **${item.interest}** — [${item.title.replace(/[[\]]/g, "")}](${item.link})`,
  );
  const top = [
    ...fresh,
    ...earlier.map((line) => line.replace(/ \(\d{4}-\d{2}-\d{2}\)$/, "")),
  ]
    .filter((line, index, all) => all.indexOf(line) === index)
    .slice(0, 3);
  const hasFile = Boolean(brief?.file) || earlier.length > 0;
  const briefLines = [
    ...top,
    ...(hasFile ? [`- Full brief: [${date}](reports/briefs/${date}.md)`] : []),
    ...(brief?.resurface ? [`- Look again: ${brief.resurface}`] : []),
    ...(options.news
      ? [`- ${options.news.replace(/\s+/g, " ").slice(0, 600)}`]
      : []),
  ];

  const body = [
    "## Today",
    ...section("Focus", tasks, "no open task"),
    ...section("Coming up", deadlines),
    ...section("Open loops", loops),
    ...section("Your hours", hours),
    ...section("Waiting on you", waiting),
    ...section("Ocean", activity),
    "",
    "## Brief",
    "",
    ...(briefLines.length
      ? briefLines
      : ["- nothing new from the sources you follow"]),
  ].join("\n");
  const plan: DayPlan = {
    date,
    note: noteRelative(date),
    tasks,
    deadlines,
    loops,
    schedule: hours,
    waiting,
    activity,
    brief: briefLines,
  };
  if (!options.apply) return plan;
  const file = noteFile(date);
  await mkdir(path.dirname(file), { recursive: true });
  await withFileLock(file, async () => {
    const note = await readFile(file, "utf8").catch(() => null);
    const kept = keepTicks(note ? readBlock(note, "day") : "", body);
    await atomicWrite(file, dropEmptyStubs(putBlock(note, date, "day", kept)));
  });
  return plan;
}

// The old template's headings (Focus, Work log, Decisions, Problems, Next, Observations) left
// empty are dropped: the blocks say all of that now. A heading with anything under it stays.
export function dropEmptyStubs(note: string): string {
  return note.replace(
    /^## (Focus|Work log|Decisions|Problems|Next|Observations)\n+(?=## |<!-- ocean:|$(?![\s\S]))/gm,
    "",
  );
}

export { readBlock };
