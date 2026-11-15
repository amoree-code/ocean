import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, parseFrontmatter } from "@ocean/core/shared/fs-utils.js";
import {
  DAILY_DIR,
  KNOWLEDGE_DIR,
  NOTES_DIR,
  oceanPath,
  PERSONAL_DIR,
  SYSTEM_DIR,
} from "@ocean/core/shared/paths.js";

// The daily brief (T-314): what moved in the things the owner follows. Interests are files in
// 02-personal/interests/ (`type: interest`, priority, keywords, sources); a source is a feed URL
// (RSS or Atom) or `github:<owner>/<repo>` for that repo's releases. A seen-ledger keeps an item
// from coming back. Daily: high-priority interests only, five items at most. Weekly: every
// interest, fifteen at most. No model and no web search here: the brief is the feed, filtered.

export const INTERESTS_DIR = `${PERSONAL_DIR}/interests`;
const BRIEFS_DIR = `${DAILY_DIR}/briefs`;
const DAILY_LIMIT = 5;
const WEEKLY_LIMIT = 15;
const FETCH_TIMEOUT_MS = 10_000;

export type Interest = {
  file: string;
  name: string;
  priority: "high" | "medium" | "low";
  keywords: string[];
  sources: string[];
};

export type FeedItem = { title: string; link: string; date: string };
export type BriefItem = FeedItem & { interest: string };
export type FetchText = (url: string) => Promise<string | null>;

function listField(block: string, key: string): string[] {
  const lines = block.split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index < 0) return [];
  const unquote = (item: string) => item.trim().replace(/^["']|["']$/g, "");
  const inline = /\[(.*)\]/.exec(lines[index]);
  if (inline) return inline[1].split(",").map(unquote).filter(Boolean);
  const items: string[] = [];
  for (const line of lines.slice(index + 1)) {
    const match = /^\s+-\s*(.+)$/.exec(line);
    if (!match) break;
    items.push(unquote(match[1]));
  }
  return items.filter(Boolean);
}

export async function listInterests(): Promise<Interest[]> {
  const dir = oceanPath(INTERESTS_DIR);
  const names = await readdir(dir).catch(() => [] as string[]);
  const interests: Interest[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".md") || name.startsWith(".")) continue;
    const source = (await readFile(path.join(dir, name), "utf8")).replace(
      /\r\n/g,
      "\n",
    );
    const fields = parseFrontmatter(source);
    if (fields.type !== "interest") continue;
    const end = source.startsWith("---") ? source.indexOf("\n---", 3) : -1;
    const block = end < 0 ? "" : source.slice(3, end);
    const heading = /^#\s+(.+)$/m.exec(
      end < 0 ? source : source.slice(end + 4),
    );
    const priority = ["high", "medium", "low"].includes(fields.priority ?? "")
      ? (fields.priority as Interest["priority"])
      : "medium";
    interests.push({
      file: `${INTERESTS_DIR}/${name}`,
      name: heading?.[1]?.trim() ?? name.replace(/\.md$/, ""),
      priority,
      keywords: listField(block, "keywords"),
      sources: listField(block, "sources"),
    });
  }
  return interests;
}

export function sourceUrl(source: string): string | null {
  const github = /^github:([\w.-]+\/[\w.-]+)$/.exec(source);
  if (github) return `https://github.com/${github[1]}/releases.atom`;
  return /^https:\/\//.test(source) ? source : null;
}

const decode = (text: string) =>
  text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

// Atom <entry> and RSS <item>, read by pattern: a feed is untrusted text, never executed.
export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  for (const match of xml.matchAll(/<(entry|item)\b[\s\S]*?<\/\1>/g)) {
    const block = match[0];
    const tag = (name: string) =>
      new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(block)?.[1];
    const title = decode(tag("title") ?? "");
    const link =
      /<link\b[^>]*href="([^"]+)"/.exec(block)?.[1] ??
      decode(tag("link") ?? "");
    const date = decode(
      tag("updated") ?? tag("published") ?? tag("pubDate") ?? "",
    );
    // A link that could break out of the markdown line it is written into is dropped.
    if (title && /^https:\/\/[^\s()<>[\]]+$/.test(link))
      items.push({
        title: title.replace(/[<>[\]]/g, "").slice(0, 200),
        link,
        date: Number.isNaN(Date.parse(date))
          ? ""
          : new Date(date).toISOString(),
      });
  }
  return items;
}

const defaultFetch: FetchText = async (url) => {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "ocean-brief" },
    });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
};

const seenFile = () => oceanPath(SYSTEM_DIR, "state", "brief", "seen.json");
const itemKey = (item: FeedItem) =>
  createHash("sha256").update(item.link).digest("hex").slice(0, 24);

async function readSeen(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(seenFile(), "utf8"));
  } catch {
    return {};
  }
}

export type BriefResult = {
  file: string | null;
  items: BriefItem[];
  failedSources: string[];
  resurface?: string | null;
};

const REEVALUATE_DAYS = 90;

// One thing from the past per daily brief (T-314): the decision verified longest ago, once that is
// more than 90 days back (it needs re-evaluation), else the owner's least recently touched note.
export async function pickResurface(date: string): Promise<string | null> {
  const cutoff = Date.parse(date) - REEVALUATE_DAYS * 24 * 60 * 60 * 1000;
  const decisions = oceanPath(KNOWLEDGE_DIR, "decisions");
  let oldest: { file: string; at: number } | null = null;
  for (const name of await readdir(decisions).catch(() => [] as string[])) {
    if (!name.endsWith(".md")) continue;
    const fields = parseFrontmatter(
      await readFile(path.join(decisions, name), "utf8"),
    );
    if (fields.status === "retired" || fields.status === "superseded") continue;
    const at = Date.parse(fields.last_verified ?? fields.updated ?? "");
    if (Number.isNaN(at) || at >= cutoff) continue;
    if (!oldest || at < oldest.at) oldest = { file: name, at };
  }
  if (oldest)
    return `${KNOWLEDGE_DIR}/decisions/${oldest.file} — needs re-evaluation (last verified ${new Date(oldest.at).toISOString().slice(0, 10)})`;
  const notes = oceanPath(NOTES_DIR);
  let quiet: { file: string; at: number } | null = null;
  for (const name of await readdir(notes).catch(() => [] as string[])) {
    if (!name.endsWith(".md")) continue;
    const at = (await stat(path.join(notes, name))).mtimeMs;
    if (!quiet || at < quiet.at) quiet = { file: name, at };
  }
  return quiet
    ? `${NOTES_DIR}/${quiet.file} — one of your notes, worth a second look`
    : null;
}

export async function buildBrief(options: {
  date: string;
  weekly?: boolean;
  dryRun?: boolean;
  fetchText?: FetchText;
}): Promise<BriefResult> {
  const fetchText = options.fetchText ?? defaultFetch;
  const seen = await readSeen();
  const failedSources: string[] = [];
  const found: (BriefItem & { rank: number })[] = [];
  const order = { high: 0, medium: 1, low: 2 };
  const interests = (await listInterests())
    .filter((interest) => options.weekly || interest.priority === "high")
    .sort((a, b) => order[a.priority] - order[b.priority]);
  for (const interest of interests) {
    const keywords = interest.keywords.map((word) => word.toLowerCase());
    for (const source of interest.sources) {
      const url = sourceUrl(source);
      const xml = url ? await fetchText(url) : null;
      if (xml === null) {
        failedSources.push(source);
        continue;
      }
      for (const item of parseFeed(xml)) {
        if (seen[itemKey(item)]) continue;
        if (found.some((other) => other.link === item.link)) continue;
        // A releases feed is wanted whole; a general feed is narrowed by the keywords.
        const general = !source.startsWith("github:");
        if (
          general &&
          keywords.length &&
          !keywords.some((word) => item.title.toLowerCase().includes(word))
        )
          continue;
        found.push({
          ...item,
          interest: interest.name,
          rank: order[interest.priority],
        });
      }
    }
  }
  const limit = options.weekly ? WEEKLY_LIMIT : DAILY_LIMIT;
  // Higher priority first, then newest; feed order breaks ties (Array.sort is stable).
  const items = [...found]
    .sort((a, b) => a.rank - b.rank || b.date.localeCompare(a.date))
    .slice(0, limit)
    .map(({ rank: _rank, ...item }) => item);
  const resurface = options.weekly ? null : await pickResurface(options.date);
  // A day with nothing new still gets its Resurface line.
  if (options.dryRun || (!items.length && !resurface))
    return { file: null, items, failedSources, resurface };
  const relative = `${BRIEFS_DIR}/${options.date}${options.weekly ? "-weekly" : ""}.md`;
  const lines = items.map(
    (item) =>
      `- **${item.interest}** — [${item.title.replace(/[[\]]/g, "")}](${item.link})${item.date ? ` (${item.date.slice(0, 10)})` : ""}`,
  );
  const file = oceanPath(relative);
  // A second run the same day adds to that day's brief; the items already there stay.
  const earlier = (await readFile(file, "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line.startsWith("- **"));
  const all = [...earlier, ...lines];
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(
    file,
    `---\ntype: brief\ndate: ${options.date}\ncadence: ${options.weekly ? "weekly" : "daily"}\nitems: ${all.length}\n---\n\n# Brief — ${options.date}\n\n${all.join("\n")}\n${resurface ? `\n## Resurface\n\n- ${resurface}\n` : ""}`,
  );
  for (const item of items) seen[itemKey(item)] = options.date;
  await mkdir(path.dirname(seenFile()), { recursive: true });
  await atomicWrite(seenFile(), `${JSON.stringify(seen, null, 2)}\n`, 0o600);
  return { file: relative, items, failedSources, resurface };
}
