import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { syncMemoryIndexes } from "@ocean/brain/memory/index-sync.js";
import { containsKnownSecret } from "@ocean/core/domain/redaction/redaction.js";
import type {
  Session,
  SessionEvent,
} from "@ocean/core/domain/sessions/session.js";
import {
  atomicWrite,
  parseFrontmatter,
  withFileLock,
} from "@ocean/core/shared/fs-utils.js";
import {
  DAILY_DIR,
  INBOX_DIR,
  KNOWLEDGE_DIR,
  oceanPath,
  SYSTEM_DIR,
} from "@ocean/core/shared/paths.js";
import { keepTicks, noteFile, putBlock, readBlock } from "../day/note.js";
import { section } from "../distill/distill.js";

// The daily harvest (T-314): every session of a day, from every AI client, becomes one summary in
// that day's note, and what the sessions decided, fixed and learned is filed into 05-knowledge on
// its own, with no review step (owner's decision, 2026-11-16). Safety instead of review: a record
// that already says the same thing is strengthened, not duplicated; every write is in a ledger
// with the record's previous version, and `ocean harvest undo <date>` takes a day back. Nothing
// here calls a model: the judgement work (legacy records, imports, corrections that become rules)
// is the daily-harvest skill's.

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SESSION_MS = 8 * 60 * 60 * 1000;
const MIN_ITEM = 25;
const SAME_TITLE = 0.6;

// Where each kind of harvested item is filed, and the record type it carries.
const KINDS = {
  decision: { heading: "Decisions", folder: "decisions" },
  solution: { heading: "Problems → fixes", folder: "solutions" },
  discovery: { heading: "Learned", folder: "discoveries" },
} as const;
type Kind = keyof typeof KINDS;

export type DaySession = {
  file: string;
  relative: string;
  title: string;
  date: string;
  project: string;
  provider: string;
  status: string;
  text: string;
};

export type HarvestItem = { kind: Kind; text: string; session: DaySession };

export type HarvestLedger = {
  date: string;
  created: string[];
  updated: { file: string; copy: string }[];
};

export type HarvestResult = {
  date: string;
  sessions: number;
  note: string | null;
  created: string[];
  strengthened: string[];
  corrections: string[];
  minutes: Record<string, number>;
};

const relativeOf = (file: string) =>
  path.relative(oceanPath(), file).split(path.sep).join("/");
const sessionsRoot = () => oceanPath(DAILY_DIR, "sessions");
const stateDir = (...parts: string[]) =>
  oceanPath(SYSTEM_DIR, "state", "harvest", ...parts);

async function markdownIn(dir: string, skipArchive = true): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (skipArchive && entry.name === "archive") continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory())
      files.push(...(await markdownIn(file, skipArchive)));
    else if (entry.name.endsWith(".md")) files.push(file);
  }
  return files.sort();
}

// A title made from a client's raw first turn carries its tags (`<command-message>…`,
// `<ide_opened_file>…`); what is left after them, or the project, is the title.
export function cleanTitle(raw: string, fallback: string): string {
  const text = raw
    .replace(/<([\w-]+)>[\s\S]*?<\/\1>/g, (whole, tag: string) =>
      /^(command-name|command-args)$/.test(tag)
        ? whole.replace(/<[^>]+>/g, " ")
        : " ",
    )
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (text || fallback).slice(0, 120);
}

export async function daySessions(date: string): Promise<DaySession[]> {
  const sessions: DaySession[] = [];
  for (const file of await markdownIn(
    path.join(sessionsRoot(), date.slice(0, 7)),
  )) {
    const text = (await readFile(file, "utf8")).replace(/\r\n/g, "\n");
    const fields = parseFrontmatter(text);
    if (fields.type !== "session" || fields.date !== date) continue;
    sessions.push({
      file,
      relative: relativeOf(file),
      title: cleanTitle(
        /^# (.+)$/m.exec(text)?.[1] ?? "",
        fields.project || path.basename(file, ".md"),
      ),
      date,
      project:
        fields.project || /^- Project: (.+)$/m.exec(text)?.[1]?.trim() || "",
      // A legacy record keeps its client in the body ("- Provider: claude").
      provider:
        fields.provider || /^- Provider: (.+)$/m.exec(text)?.[1]?.trim() || "",
      status: fields.status || "",
      text,
    });
  }
  return sessions;
}

const clean = (text: string) =>
  text
    .replace(/^[-*]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();

// A section's items: its bullets, or the whole paragraph when it has none. Placeholders and
// fragments too short to stand alone are dropped.
export function sectionItems(text: string, heading: string): string[] {
  const body = section(text, heading);
  if (!body) return [];
  const lines = body.split("\n").filter((line) => line.trim());
  const bullets = lines.filter((line) => /^\s*[-*]\s+/.test(line));
  const items = bullets.length ? bullets.map(clean) : [clean(body)];
  return items.filter(
    (item) =>
      item.length >= MIN_ITEM &&
      !/^(none|n\/a|nothing|no )/i.test(item) &&
      !containsKnownSecret(item),
  );
}

// A record written with sections (Goal, Outcome, Decisions, …) can be mined here; an older dump
// (one "What happened" paragraph) needs the skill's reading.
export const structured = (session: DaySession) =>
  /^## (Goal|Outcome|Decisions|Learned)$/m.test(session.text);

export function harvestItems(sessions: DaySession[]): HarvestItem[] {
  const items: HarvestItem[] = [];
  for (const session of sessions)
    for (const kind of Object.keys(KINDS) as Kind[])
      for (const text of sectionItems(session.text, KINDS[kind].heading))
        items.push({ kind, text, session });
  return items;
}

// What the owner said to correct an AI ("no, not like that", "غلط", "don't …"): candidates for a
// standing rule. Read from his own turns only, never the model's.
const CORRECTION =
  /(^|[\s,.!])(no,|nope|wrong|don't|do not|stop |not like that|i said|instead of)|(^|\s)(لا |غلط|مو هيچ|مو هيج|مو هيك|ما اريد|لا تسوي|ليش سويت|گلتلك|قلتلك)/i;

export function detectCorrections(events: SessionEvent[]): string[] {
  const found: string[] = [];
  for (const event of events) {
    if (event.type !== "user_input") continue;
    const text = event.data.replace(/\s+/g, " ").trim();
    if (!text || text.length > 600 || containsKnownSecret(text)) continue;
    // Text a client injects as the user's turn (a skill body, a command, a notice) is not his.
    if (
      /^(base directory for this skill|<|caveat:|\[request interrupted|this session is being continued)/i.test(
        text,
      )
    )
      continue;
    if (CORRECTION.test(text)) found.push(text.slice(0, 160));
  }
  return found;
}

const localDay = (iso: string) => {
  const day = new Date(iso);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
};

// Minutes per project for sessions started that day: from the start to the latest of its close,
// its last update and its last event, each session capped at eight hours. A session the store saw
// only for seconds counts nothing, and a project with nothing recorded is left out.
export function minutesByProject(
  sessions: Session[],
  date: string,
  eventsOf: (id: string) => SessionEvent[] = () => [],
): Record<string, number> {
  const minutes: Record<string, number> = {};
  for (const session of sessions) {
    if (localDay(session.createdAt) !== date) continue;
    const ends = [
      session.closedAt,
      session.updatedAt,
      ...eventsOf(session.sessionId).map((event) => event.createdAt),
    ]
      .map((time) => Date.parse(time ?? ""))
      .filter((time) => !Number.isNaN(time));
    const span = Math.min(
      Math.max(0, Math.max(...ends, 0) - Date.parse(session.createdAt)),
      MAX_SESSION_MS,
    );
    const counted = Math.round(span / 60_000);
    if (!counted) continue;
    const project =
      session.projectId || path.basename(session.workingDirectory) || "other";
    minutes[project] = (minutes[project] ?? 0) + counted;
  }
  return minutes;
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/`[^`]*`/g, (code) => code.slice(1, -1))
    .replace(/[^a-z0-9؀-ۿ]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 8)
    .join("-")
    .slice(0, 80);

const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9؀-ۿ]+/)
      .filter((word) => word.length > 2),
  );

function similarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  // Too few words to tell two statements apart: never the same record.
  if (Math.min(left.size, right.size) < 3) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / Math.min(left.size, right.size);
}

const titleOf = (text: string) => {
  const sentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  return sentence.length > 90 ? `${sentence.slice(0, 87).trim()}…` : sentence;
};

function setField(text: string, key: string, value: string): string {
  const end = text.startsWith("---\n") ? text.indexOf("\n---", 3) : -1;
  if (end < 0) return text;
  const head = text.slice(0, end);
  const line = new RegExp(`^${key}:.*$`, "m");
  const next = line.test(head)
    ? head.replace(line, `${key}: ${value}`)
    : `${head}\n${key}: ${value}`;
  return next + text.slice(end);
}

// One harvested item into 05-knowledge: the record that already says it gains this day as
// evidence and a fresh last_verified; otherwise a new record. Returns the file and what happened.
async function fileItem(
  item: HarvestItem,
  ledger: HarvestLedger,
): Promise<{ file: string; action: "created" | "strengthened" | "same" }> {
  const folder = oceanPath(KNOWLEDGE_DIR, KINDS[item.kind].folder);
  const title = titleOf(item.text);
  let match: string | null = null;
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    if (!name.endsWith(".md")) continue;
    const existing = await readFile(path.join(folder, name), "utf8");
    const heading = /^# (.+)$/m.exec(existing)?.[1] ?? name;
    if (
      name === `${slug(item.text)}.md` ||
      similarity(heading, title) >= SAME_TITLE
    ) {
      match = path.join(folder, name);
      break;
    }
  }
  const link = `- ${item.session.date}: [${item.session.title.replace(/[[\]]/g, "")}](${path
    .relative(folder, item.session.file)
    .split(path.sep)
    .join("/")})`;
  if (match) {
    const current = await readFile(match, "utf8");
    if (current.includes(link))
      return { file: relativeOf(match), action: "same" };
    const copy = stateDir("versions", ledger.date, relativeOf(match));
    await mkdir(path.dirname(copy), { recursive: true, mode: 0o700 });
    await copyFile(match, copy);
    ledger.updated.push({ file: relativeOf(match), copy: relativeOf(copy) });
    let next = setField(current, "last_verified", item.session.date);
    next = /^## Evidence$/m.test(next)
      ? next.replace(/^## Evidence\n+/m, (head) => `${head}${link}\n`)
      : `${next.replace(/\n*$/, "")}\n\n## Evidence\n\n${link}\n`;
    await atomicWrite(match, next);
    return { file: relativeOf(match), action: "strengthened" };
  }
  const file = path.join(folder, `${slug(item.text) || "untitled"}.md`);
  const body = [
    "---",
    `type: ${item.kind}`,
    `title: ${JSON.stringify(title)}`,
    "status: active",
    "origin: harvested",
    `source: ${JSON.stringify(`session:${item.session.provider || "unknown"}`)}`,
    ...(item.session.project
      ? [`project: ${JSON.stringify(item.session.project)}`]
      : []),
    `created: ${item.session.date}`,
    `last_verified: ${item.session.date}`,
    "---",
    "",
    `# ${title}`,
    "",
    item.text,
    "",
    "## Evidence",
    "",
    link,
    "",
  ].join("\n");
  await mkdir(folder, { recursive: true });
  await atomicWrite(file, body);
  ledger.created.push(relativeOf(file));
  return { file: relativeOf(file), action: "created" };
}

function dayBlock(input: {
  sessions: DaySession[];
  items: HarvestItem[];
  filed: Map<HarvestItem, string>;
  corrections: string[];
  minutes: Record<string, number>;
  captures: string[];
  date: string;
}): string {
  const link = (session: DaySession) =>
    `[${session.title.replace(/[[\]]/g, "")}](${path
      .relative(oceanPath(DAILY_DIR), session.file)
      .split(path.sep)
      .join("/")})`;
  const byProvider = new Map<string, number>();
  for (const session of input.sessions)
    byProvider.set(
      session.provider || "unknown",
      (byProvider.get(session.provider || "unknown") ?? 0) + 1,
    );
  const kind = (k: Kind, label: string) => {
    const items = input.items.filter((item) => item.kind === k);
    return items.length
      ? [
          "",
          `### ${label}`,
          "",
          ...items.map((item) => {
            const filed = input.filed.get(item);
            return `- ${item.text}${filed ? ` → \`${filed}\`` : ""} (${link(item.session)})`;
          }),
        ]
      : [];
  };
  // Every Next a session left is an open loop: carried forward each morning until ticked.
  const loops = input.sessions.flatMap((session) =>
    sectionItems(session.text, "Next").map(
      (item) => `- [ ] ${item} (${link(session)})`,
    ),
  );
  const minutes = Object.entries(input.minutes).sort((a, b) => b[1] - a[1]);
  return [
    "## Day summary",
    "",
    `${input.sessions.length} session(s): ${[...byProvider].map(([provider, n]) => `${provider} ${n}`).join(", ") || "none"}.`,
    "",
    "### Sessions",
    "",
    ...(input.sessions.length
      ? input.sessions.map(
          (session) =>
            `- ${link(session)} — ${[session.project, session.provider, session.status].filter(Boolean).join(" · ")}`,
        )
      : ["- none"]),
    ...kind("decision", "Decisions"),
    ...kind("solution", "Problems → fixes"),
    ...kind("discovery", "Learned"),
    ...(input.captures.length
      ? ["", "### Captured", "", ...input.captures]
      : []),
    ...(input.filed.size
      ? [
          "",
          `_Filed into knowledge on its own; undo with \`ocean harvest undo ${input.date}\`._`,
        ]
      : []),
    ...(loops.length ? ["", "## Open loops", "", ...loops] : []),
    ...(input.corrections.length
      ? [
          "",
          "## Corrections",
          "",
          ...input.corrections.map((text) => `- ${text}`),
        ]
      : []),
    ...(minutes.length
      ? [
          "",
          "## Time",
          "",
          ...minutes.map(
            ([project, n]) =>
              `- ${project}: ${Math.floor(n / 60)}h ${String(n % 60).padStart(2, "0")}m`,
          ),
        ]
      : []),
  ].join("\n");
}

// Captures written that day (00-inbox/captures/), linked from the day's account.
async function dayCaptures(date: string): Promise<string[]> {
  const dir = oceanPath(INBOX_DIR, "captures");
  const lines: string[] = [];
  for (const name of (await readdir(dir).catch(() => [] as string[])).sort()) {
    if (!name.endsWith(".md")) continue;
    const text = await readFile(path.join(dir, name), "utf8").catch(() => "");
    const fields = parseFrontmatter(text);
    const created = fields.created || fields.date || name;
    if (!created.startsWith(date) && localDay(created) !== date) continue;
    const title =
      /^# (.+)$/m.exec(text)?.[1]?.trim() || name.replace(/\.md$/, "");
    lines.push(
      `- [${title.replace(/[[\]]/g, "")}](../${INBOX_DIR}/captures/${name})`,
    );
  }
  return lines;
}

const ledgerFile = (date: string) => stateDir("ledger", `${date}.json`);

export async function harvestDay(options: {
  date: string;
  apply: boolean;
  store?: { sessions: Session[]; eventsOf: (id: string) => SessionEvent[] };
}): Promise<HarvestResult> {
  const { date } = options;
  const sessions = await daySessions(date);
  const items = harvestItems(sessions);
  const ofDay = (options.store?.sessions ?? []).filter(
    (session) => localDay(session.createdAt) === date,
  );
  const corrections = [
    ...new Set(
      ofDay.flatMap((session) =>
        detectCorrections(options.store?.eventsOf(session.sessionId) ?? []),
      ),
    ),
  ];
  const minutes = minutesByProject(ofDay, date, (id) =>
    options.store ? options.store.eventsOf(id) : [],
  );
  const result: HarvestResult = {
    date,
    sessions: sessions.length,
    note: null,
    created: [],
    strengthened: [],
    corrections,
    minutes,
  };
  const captures = await dayCaptures(date);
  if (!sessions.length && !ofDay.length && !captures.length) return result;
  result.note = `${DAILY_DIR}/${date}.md`;
  if (!options.apply) {
    result.created = items.map(
      (item) => `${KINDS[item.kind].folder}: ${titleOf(item.text)}`,
    );
    return result;
  }
  const previous: HarvestLedger = JSON.parse(
    await readFile(ledgerFile(date), "utf8").catch(() => "null"),
  ) ?? { date, created: [], updated: [] };
  const filed = new Map<HarvestItem, string>();
  for (const item of items) {
    const { file, action } = await fileItem(item, previous);
    filed.set(item, file);
    if (action === "created") result.created.push(file);
    if (action === "strengthened") result.strengthened.push(file);
  }
  await mkdir(path.dirname(ledgerFile(date)), { recursive: true, mode: 0o700 });
  await atomicWrite(ledgerFile(date), `${JSON.stringify(previous, null, 2)}\n`);
  const file = noteFile(date);
  await mkdir(path.dirname(file), { recursive: true });
  const body = dayBlock({
    sessions,
    items,
    filed,
    corrections,
    minutes,
    captures,
    date,
  });
  await withFileLock(file, async () => {
    const note = await readFile(file, "utf8").catch(() => null);
    const kept = keepTicks(note ? readBlock(note, "harvest") : "", body);
    await atomicWrite(file, putBlock(note, date, "harvest", kept));
  });
  // A legacy record (no sections) is summarized here but read by the daily-harvest skill, which
  // marks it once it has mined it.
  for (const session of sessions.filter(structured))
    await atomicWrite(session.file, setField(session.text, "harvested", date));
  if (result.created.length || result.strengthened.length)
    await syncMemoryIndexes(true);
  return result;
}

// Days before today whose session records have not been harvested yet (the service runs this).
export async function pendingDays(
  today: string,
  lookbackDays = 45,
): Promise<string[]> {
  const cutoff = new Date(Date.parse(today) - lookbackDays * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const days = new Set<string>();
  for (const file of await markdownIn(sessionsRoot())) {
    const head = (await readFile(file, "utf8")).slice(0, 4096);
    const fields = parseFrontmatter(head);
    if (fields.type !== "session" || fields.harvested) continue;
    if (fields.date && fields.date < today && fields.date >= cutoff)
      days.add(fields.date);
  }
  return [...days].sort();
}

// Undo one day's knowledge writes: records it created are removed, records it strengthened get
// their earlier version back. The day's summary and session flags stay.
export async function undoDay(
  date: string,
): Promise<{ removed: string[]; restored: string[] }> {
  const ledger: HarvestLedger | null = JSON.parse(
    await readFile(ledgerFile(date), "utf8").catch(() => "null"),
  );
  if (!ledger) throw new Error(`no harvest ledger for ${date}`);
  const removed: string[] = [];
  const restored: string[] = [];
  for (const file of ledger.created) {
    await rm(oceanPath(file), { force: true });
    removed.push(file);
  }
  // Oldest version first wins: a file strengthened twice returns to how it was before the day.
  const seen = new Set<string>();
  for (const { file, copy } of ledger.updated) {
    if (seen.has(file)) continue;
    seen.add(file);
    await copyFile(oceanPath(copy), oceanPath(file));
    restored.push(file);
  }
  await rename(ledgerFile(date), stateDir("ledger", `${date}.undone.json`));
  return { removed, restored };
}

// After `days`, a harvested day leaves the working folders: the day's note to
// 01-daily/archive/<YYYY-MM>/, its session records to 01-daily/sessions/archive/<YYYY-MM>/ (still
// searched). Nothing is deleted, and nothing unharvested moves.
export async function archiveHarvested(options: {
  today: string;
  days?: number;
  apply: boolean;
}): Promise<{ notes: string[]; sessions: string[] }> {
  const cutoff = new Date(
    Date.parse(options.today) - (options.days ?? 30) * DAY_MS,
  )
    .toISOString()
    .slice(0, 10);
  const moves: { from: string; to: string; kind: "notes" | "sessions" }[] = [];
  for (const file of await markdownIn(sessionsRoot())) {
    const fields = parseFrontmatter(
      (await readFile(file, "utf8")).slice(0, 4096),
    );
    if (fields.type !== "session" || !fields.date || fields.date >= cutoff)
      continue;
    if (!fields.harvested) continue;
    moves.push({
      from: file,
      to: path.join(
        sessionsRoot(),
        "archive",
        fields.date.slice(0, 7),
        path.basename(file),
      ),
      kind: "sessions",
    });
  }
  for (const name of await readdir(oceanPath(DAILY_DIR)).catch(
    () => [] as string[],
  )) {
    const day = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(name)?.[1];
    if (!day || day >= cutoff) continue;
    // A day leaves once none of its sessions waits to be harvested.
    if (
      (await daySessions(day)).some(
        (session) => !/^harvested:/m.test(session.text),
      )
    )
      continue;
    moves.push({
      from: oceanPath(DAILY_DIR, name),
      to: oceanPath(DAILY_DIR, "archive", day.slice(0, 7), name),
      kind: "notes",
    });
  }
  const result = {
    notes: [] as string[],
    sessions: [] as string[],
    emptied: [] as string[],
  };
  for (const move of moves) {
    result[move.kind].push(relativeOf(move.to));
    if (!options.apply) continue;
    await mkdir(path.dirname(move.to), { recursive: true });
    await rename(move.from, move.to);
  }
  // The inbox keeps no empty folders: reviewed candidate days, the retired brain-dump folder.
  const candidates = oceanPath(INBOX_DIR, "candidates");
  const empty = [
    ...(await readdir(candidates).catch(() => [] as string[])).map((name) =>
      path.join(candidates, name),
    ),
    oceanPath(INBOX_DIR, "brain-dump"),
  ];
  for (const dir of empty) {
    const inside = await readdir(dir).catch(() => null);
    if (!inside || inside.some((name) => name !== ".DS_Store")) continue;
    result.emptied.push(relativeOf(dir));
    if (options.apply) await rm(dir, { recursive: true, force: true });
  }
  return result;
}
