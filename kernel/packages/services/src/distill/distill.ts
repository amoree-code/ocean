import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { proposeMemory } from "@ocean/brain/memory/memory-write.js";
import { MemoryContractError } from "@ocean/core/domain/mcp/memory-contract.js";
import { atomicWrite, parseFrontmatter } from "@ocean/core/shared/fs-utils.js";
import {
  DAILY_DIR,
  INBOX_DIR,
  KNOWLEDGE_DIR,
  oceanPath,
} from "@ocean/core/shared/paths.js";

// The weekly distill (T-314): a week's session records and briefs become one digest in
// 01-daily/weekly/, the Decisions and Learned sections become knowledge candidates for review,
// each record read is marked `distilled: true`, and inbox captures marked processed move to
// 00-inbox/archive/<week>/. Dry run unless `apply`. Nothing is written as knowledge directly.

const DAY = 24 * 60 * 60 * 1000;

// ISO week of a YYYY-MM-DD date: its label (2026-W47) and its Monday..Sunday.
export function isoWeek(date: string): {
  label: string;
  from: string;
  to: string;
} {
  const day = new Date(`${date}T00:00:00Z`);
  const weekday = (day.getUTCDay() + 6) % 7;
  const monday = new Date(day.getTime() - weekday * DAY);
  const thursday = new Date(monday.getTime() + 3 * DAY);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / DAY + 1) / 7);
  const iso = (time: number) => new Date(time).toISOString().slice(0, 10);
  return {
    label: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`,
    from: iso(monday.getTime()),
    to: iso(monday.getTime() + 6 * DAY),
  };
}

async function markdownIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownIn(file)));
    else if (entry.name.endsWith(".md")) files.push(file);
  }
  return files.sort();
}

function section(text: string, heading: string): string {
  const match = new RegExp(
    // `(?![\\s\\S])` is the end of the text: with the m flag, `$` would end it at the first line.
    `^## ${heading}\\n+([\\s\\S]*?)(?=\\n## |\\nRaw events|(?![\\s\\S]))`,
    "m",
  ).exec(text);
  return match?.[1]?.trim() ?? "";
}

const relativeOf = (file: string) =>
  path.relative(oceanPath(), file).split(path.sep).join("/");

// Within the frontmatter only: a body line that happens to start with `distilled:` is left alone.
function setDistilled(text: string): string {
  const end = text.startsWith("---\n") ? text.indexOf("\n---", 3) : -1;
  if (end < 0) return text;
  const head = text.slice(0, end);
  const next = /^distilled:.*$/m.test(head)
    ? head.replace(/^distilled:.*$/m, "distilled: true")
    : `${head}\ndistilled: true`;
  return next + text.slice(end);
}

export type DistillResult = {
  week: string;
  digest: string | null;
  sessions: string[];
  candidates: string[];
  archived: string[];
};

export async function distillWeek(options: {
  date: string;
  apply: boolean;
}): Promise<DistillResult> {
  const week = isoWeek(options.date);
  const inWeek = (date: string | undefined) =>
    !!date && date >= week.from && date <= week.to;
  const sessions: {
    file: string;
    text: string;
    title: string;
    status: string;
  }[] = [];
  for (const file of await markdownIn(oceanPath(DAILY_DIR, "sessions"))) {
    const text = await readFile(file, "utf8");
    const fields = parseFrontmatter(text);
    if (fields.type !== "session" || fields.distilled === "true") continue;
    if (!inWeek(fields.date)) continue;
    const title =
      /^# (.+)$/m.exec(text)?.[1]?.trim() ?? path.basename(file, ".md");
    sessions.push({ file, text, title, status: fields.status ?? "" });
  }
  const briefs = (await markdownIn(oceanPath(DAILY_DIR, "briefs"))).filter(
    (file) => inWeek(/(\d{4}-\d{2}-\d{2})/.exec(path.basename(file))?.[1]),
  );
  const captures: string[] = [];
  for (const file of await markdownIn(oceanPath(INBOX_DIR, "captures")))
    if (/^status:\s*processed\s*$/m.test(await readFile(file, "utf8")))
      captures.push(file);
  const result: DistillResult = {
    week: week.label,
    digest: null,
    sessions: sessions.map((item) => relativeOf(item.file)),
    candidates: [],
    archived: captures.map(
      (file) => `${INBOX_DIR}/archive/${week.label}/${path.basename(file)}`,
    ),
  };
  const archiveCaptures = async () => {
    for (const file of captures) {
      const target = oceanPath(
        INBOX_DIR,
        "archive",
        week.label,
        path.basename(file),
      );
      await mkdir(path.dirname(target), { recursive: true });
      await rename(file, target);
    }
  };
  if (!sessions.length && !briefs.length) {
    // No digest without records, but processed captures still leave the inbox.
    if (options.apply) await archiveCaptures();
    return result;
  }
  const pick = (heading: string) =>
    sessions
      .map((item) => ({ item, text: section(item.text, heading) }))
      .filter(({ text }) => text);
  const decisions = pick("Decisions");
  const learned = pick("Learned");
  const problems = pick("Problems → fixes");
  const next = pick("Next");
  const link = (file: string, label: string) =>
    `[${label.replace(/[[\]]/g, "")}](../${path.relative(oceanPath(DAILY_DIR), file).split(path.sep).join("/")})`;
  const list = (
    items: { item: { file: string; title: string }; text: string }[],
  ) =>
    items.map(
      ({ item, text }) =>
        `- ${link(item.file, item.title)}: ${text.replace(/\s+/g, " ").slice(0, 400)}`,
    );
  const digestRelative = `${DAILY_DIR}/weekly/${week.label}.md`;
  result.digest = digestRelative;
  if (!options.apply) return result;
  const body = [
    "---",
    "type: weekly",
    `week: ${week.label}`,
    `from: ${week.from}`,
    `to: ${week.to}`,
    `sessions: ${sessions.length}`,
    "---",
    "",
    `# Week ${week.label}`,
    "",
    "## Sessions",
    "",
    ...(sessions.length
      ? sessions.map(
          (item) =>
            `- ${link(item.file, item.title)} — ${item.status || "unknown"}`,
        )
      : ["- none"]),
    ...(decisions.length ? ["", "## Decisions", "", ...list(decisions)] : []),
    ...(problems.length
      ? ["", "## Problems → fixes", "", ...list(problems)]
      : []),
    ...(learned.length ? ["", "## Learned", "", ...list(learned)] : []),
    ...(next.length ? ["", "## Open next steps", "", ...list(next)] : []),
    ...(briefs.length
      ? [
          "",
          "## Briefs",
          "",
          ...briefs.map(
            (file) => `- ${link(file, path.basename(file, ".md"))}`,
          ),
        ]
      : []),
    "",
  ].join("\n");
  const digest = oceanPath(digestRelative);
  await mkdir(path.dirname(digest), { recursive: true });
  await atomicWrite(digest, body);
  // Decisions and lessons from the week wait for review as knowledge candidates.
  for (const [kind, items] of [
    ["decision", decisions],
    ["lesson", learned],
  ] as const)
    for (const { item, text } of items) {
      try {
        const { candidate } = await proposeMemory({
          content: `# ${item.title}\n\n${text}\n\nFrom: ${relativeOf(item.file)}\n`,
          origin: "inferred",
          source: `distill:${week.label}`,
          reason: `${kind} recorded in a session of ${week.label}; file it under ${KNOWLEDGE_DIR}/`,
          meta: { kind, week: week.label },
        });
        result.candidates.push(candidate);
      } catch (error) {
        if (!(error instanceof MemoryContractError)) throw error;
      }
    }
  for (const item of sessions)
    await atomicWrite(item.file, setDistilled(item.text));
  await archiveCaptures();
  return result;
}
