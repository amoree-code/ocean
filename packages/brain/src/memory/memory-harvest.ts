import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryContractError } from "@ocean/core/domain/mcp/memory-contract.js";
import { PROJECTS_DIR } from "@ocean/core/shared/paths.js";
import { sha256 } from "./memory-audit.js";
import { harvestLedgerFile, stagingDir } from "./memory-paths.js";
import { type CandidateMeta, proposeMemory } from "./memory-write.js";

// One-time and repeatable harvest of clients' own memory stores into candidates (T-296 §3.5,
// P4). A harvested file never becomes a record by itself: it is proposed (origin `imported`)
// for the owner's review, through proposeMemory's checks (size, secrets). A ledger of content
// hashes keeps a rerun from proposing the same text twice. The dry run names files and sizes,
// never their content. A text over the candidate limit is split at its headings into parts, each
// proposed on its own (T-305: Codex keeps one MEMORY.md of hundreds of kilobytes).

export type HarvestSource =
  | "claude-code"
  | "codex"
  | "gemini"
  | "hermes"
  | "antigravity"
  | "instructions";

export const HARVEST_SOURCES: HarvestSource[] = [
  "claude-code",
  "codex",
  "gemini",
  "hermes",
  "antigravity",
  "instructions",
];

export type HarvestItem = {
  source: HarvestSource | "claude.ai";
  file: string;
  bytes: number;
  status: "new" | "seen" | "too-large" | "secret" | "proposed";
  candidate?: string;
  project?: string;
  title?: string;
};

// Where a harvested text belongs, decided by the caller (T-305: `ocean pull` matches folders and
// names to the owner's projects). `project` is an Ocean project id, or a bucket such as
// `unassigned`; only a real project gets a record target.
export type Placement = {
  project?: string;
  tags?: string[];
  cwd?: string;
  target?: boolean;
};
export type Classify = (origin: {
  client: string;
  file: string;
  text: string;
  name?: string;
}) => Placement;

// The same text with other spacing or letter case is the same memory.
const normalizedKey = (text: string) =>
  `n:${sha256(text.toLowerCase().replace(/\s+/g, " ").trim())}`;

// A short label: the first heading, else a frontmatter name, else the first line.
export function textTitle(text: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(text)?.[1];
  const name = /^name:\s*["']?(.+?)["']?\s*$/m.exec(text)?.[1];
  const first = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && line !== "---");
  return (heading ?? name ?? first ?? "").slice(0, 100);
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "note";

// The frontmatter a pulled candidate carries, and the record it would become.
function placementMeta(
  origin: { client: string; file: string; text: string; date?: string },
  placement: Placement,
): { meta: CandidateMeta; target?: string; project: string; title: string } {
  const project = placement.project ?? "unassigned";
  const title = textTitle(origin.text);
  const meta: CandidateMeta = {
    client: origin.client,
    project,
    ...(placement.tags?.length ? { tags: placement.tags } : {}),
    ...(placement.cwd ? { cwd: placement.cwd } : {}),
    pull: true,
    pulled_at: new Date().toISOString(),
    ...(origin.date ? { date: origin.date } : {}),
    title,
    file: origin.file,
  };
  const target = placement.target
    ? `${PROJECTS_DIR}/${project}/memory/${slug(title)}-${sha256(origin.text).slice(0, 6)}.md`
    : undefined;
  return { meta, target, project, title };
}

const MAX_BYTES = 32_000;
const TEXT = /\.(md|txt)$/i;

async function filesIn(directory: string, depth = 0): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  const found: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const target = path.join(directory, entry.name);
    if (entry.isFile() && TEXT.test(entry.name)) found.push(target);
    else if (depth > 0 && entry.isDirectory())
      found.push(...(await filesIn(target, depth - 1)));
  }
  return found;
}

// Global instruction files the owner may have written by hand. The block Ocean generates from
// its own charter (`ai-sync` markers) and `@` includes of it are Ocean's already, not imported.
const INSTRUCTION_FILES = [
  ".claude/CLAUDE.md",
  ".codex/AGENTS.md",
  ".gemini/GEMINI.md",
  ".qwen/QWEN.md",
  ".config/opencode/AGENTS.md",
];
const GENERATED_BLOCK =
  /<!-- ai-sync:generated -->[\s\S]*?<!-- ai-sync:end -->/g;
const GEMINI_MEMORIES =
  /^## Gemini Added Memories\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m;

function ownedText(text: string): string {
  return text
    .replace(GENERATED_BLOCK, "")
    .replace(GEMINI_MEMORIES, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("@"))
    .join("\n")
    .trim();
}

// A text over `max` bytes, cut at the shallowest heading level that splits it; a part still too
// large is cut at the next level, then between paragraphs.
export function splitMarkdown(text: string, max = MAX_BYTES): string[] {
  const size = (value: string) => Buffer.byteLength(value, "utf8");
  if (size(text) <= max) return [text];
  for (const level of [1, 2, 3, 4]) {
    const marker = new RegExp(`^#{${level}} `, "m");
    const parts = text
      .split(new RegExp(`(?=^#{${level}} )`, "m"))
      .filter((part) => part.trim());
    if (parts.length > 1 && parts.some((part) => marker.test(part)))
      return parts.flatMap((part) => splitMarkdown(part, max));
  }
  // No heading left to cut at: group whole paragraphs. One paragraph still over the limit stays
  // whole and is reported too large; text is never cut mid-paragraph.
  const out: string[] = [];
  let current = "";
  for (const piece of text.split(/(?<=\n\n)/)) {
    if (current && size(current + piece) > max) {
      out.push(current);
      current = "";
    }
    current += piece;
  }
  if (current.trim()) out.push(current);
  return out;
}

// The texts each source holds, as (label, text) pairs. Missing stores are simply empty.
async function sourceTexts(
  source: HarvestSource,
  home: string,
): Promise<{ file: string; text: string }[]> {
  const read = async (files: string[]) =>
    Promise.all(
      files.map(async (file) => ({ file, text: await readFile(file, "utf8") })),
    );
  if (source === "claude-code") {
    const projects = path.join(home, ".claude", "projects");
    const dirs = await readdir(projects).catch(() => []);
    const files = [...(await filesIn(stagingDir("claude-code")))];
    for (const dir of dirs.sort())
      files.push(
        ...(await filesIn(path.join(projects, dir, "memory"))).filter(
          (file) => path.basename(file) !== "MEMORY.md",
        ),
      );
    return read(files);
  }
  if (source === "codex")
    // raw_memories.md concatenates the per-session rollout summaries: history, indexed by
    // `ocean pull`, not memory.
    return read(
      (await filesIn(path.join(home, ".codex", "memories"))).filter(
        (file) => path.basename(file) !== "raw_memories.md",
      ),
    );
  if (source === "instructions") {
    const texts: { file: string; text: string }[] = [];
    for (const relative of INSTRUCTION_FILES) {
      const file = path.join(home, relative);
      const text = ownedText(await readFile(file, "utf8").catch(() => ""));
      // Headings alone (what is left around a removed block) say nothing.
      if (text.split("\n").some((line) => line.trim() && !/^#+\s/.test(line)))
        texts.push({ file, text });
    }
    for (const file of await filesIn(path.join(home, ".cursor", "rules")))
      texts.push({ file, text: await readFile(file, "utf8") });
    return texts;
  }
  if (source === "hermes")
    return read(await filesIn(path.join(home, ".hermes", "memories")));
  if (source === "antigravity")
    return read(
      await filesIn(path.join(home, ".gemini", "antigravity", "brain"), 1),
    );
  const texts = await read(await filesIn(path.join(home, ".gemini", "memory")));
  // Gemini's save_memory appends under this heading in GEMINI.md.
  const geminiMd = path.join(home, ".gemini", "GEMINI.md");
  const section = GEMINI_MEMORIES.exec(
    await readFile(geminiMd, "utf8").catch(() => ""),
  )?.[1];
  if (section?.trim()) texts.push({ file: geminiMd, text: section.trim() });
  return texts;
}

const ledgerFile = harvestLedgerFile;

async function readLedger(): Promise<Record<string, string>> {
  return JSON.parse(await readFile(ledgerFile(), "utf8").catch(() => "{}"));
}

export async function harvestMemory(
  options: {
    sources?: HarvestSource[];
    apply?: boolean;
    home?: string;
    classify?: Classify;
  } = {},
): Promise<HarvestItem[]> {
  const home = options.home ?? os.homedir();
  const ledger = await readLedger();
  const items: HarvestItem[] = [];
  const shown = (file: string) =>
    file.startsWith(home) ? `~${file.slice(home.length)}` : file;
  const parts = async (source: HarvestSource) => {
    const out: { path: string; file: string; text: string; date?: string }[] =
      [];
    for (const { file, text } of await sourceTexts(source, home)) {
      const date = (await stat(file).catch(() => null))?.mtime
        .toISOString()
        .slice(0, 10);
      const pieces = splitMarkdown(text);
      pieces.forEach((piece, index) => {
        out.push({
          path: file,
          file: pieces.length > 1 ? `${shown(file)}#${index + 1}` : shown(file),
          text: piece,
          date,
        });
      });
    }
    return out;
  };
  // Keys proposed in this run too, so one text found twice is proposed once.
  const seen = new Set<string>();
  for (const source of options.sources ?? HARVEST_SOURCES) {
    for (const { path: origin, file, text, date } of await parts(source)) {
      if (!text.trim()) continue;
      const bytes = Buffer.byteLength(text, "utf8");
      const keys = [sha256(text), normalizedKey(text)];
      const placed = placementMeta(
        { client: source, file, text, date },
        options.classify?.({ client: source, file: origin, text }) ?? {},
      );
      const item: HarvestItem = {
        source,
        file,
        bytes,
        status: "new",
        project: placed.project,
        title: placed.title,
      };
      if (keys.some((key) => ledger[key] || seen.has(key)))
        item.status = "seen";
      else if (bytes > MAX_BYTES) item.status = "too-large";
      else if (options.apply)
        try {
          const proposed = await proposeMemory({
            content: text,
            origin: "imported",
            source,
            reason: `harvested from ${file}`.slice(0, 200),
            target: placed.target,
            meta: placed.meta,
          });
          for (const key of keys) ledger[key] = proposed.candidate;
          item.status = "proposed";
          item.candidate = proposed.candidate;
        } catch (error) {
          if (!(error instanceof MemoryContractError)) throw error;
          item.status = error.code === "SECRET" ? "secret" : "too-large";
        }
      for (const key of keys) seen.add(key);
      items.push(item);
    }
  }
  if (options.apply) {
    await mkdir(path.dirname(ledgerFile()), { recursive: true, mode: 0o700 });
    await writeFile(ledgerFile(), `${JSON.stringify(ledger, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  return items;
}

// claude.ai account export (ASSUMED shape, read defensively): `projects.json` as a list of
// projects with name, description, prompt_template and docs [{filename, content}]. Each project
// and each doc becomes a candidate; anything unreadable is reported, never guessed.
export async function importClaudeExport(
  directory: string,
  options: { apply?: boolean; classify?: Classify } = {},
): Promise<{ items: HarvestItem[]; problems: string[] }> {
  const problems: string[] = [];
  const items: HarvestItem[] = [];
  const file = path.join(directory, "projects.json");
  if (!(await stat(file).catch(() => null))) {
    problems.push("projects.json not found in the export");
    return { items, problems };
  }
  let projects: unknown;
  try {
    projects = JSON.parse(await readFile(file, "utf8"));
  } catch {
    problems.push("projects.json is not valid JSON");
    return { items, problems };
  }
  if (!Array.isArray(projects)) {
    problems.push("projects.json is not a list");
    return { items, problems };
  }
  const ledger = await readLedger();
  const texts: { label: string; text: string; name: string }[] = [];
  for (const raw of projects as Record<string, unknown>[]) {
    const name = typeof raw?.name === "string" ? raw.name : "untitled";
    const parts = [
      `# ${name}`,
      typeof raw.description === "string" ? raw.description : "",
      typeof raw.prompt_template === "string"
        ? `## Instructions\n\n${raw.prompt_template}`
        : "",
    ].filter(Boolean);
    texts.push({
      label: `claude.ai project ${name}`,
      text: parts.join("\n\n"),
      name,
    });
    for (const doc of Array.isArray(raw.docs) ? raw.docs : [])
      if (typeof doc?.content === "string" && doc.content.trim()) {
        const pieces = splitMarkdown(doc.content);
        pieces.forEach((piece, index) => {
          texts.push({
            label: `claude.ai project ${name} doc ${String(doc.filename ?? "")}${pieces.length > 1 ? `#${index + 1}` : ""}`,
            text: piece,
            name,
          });
        });
      }
  }
  const seen = new Set<string>();
  for (const { label, text, name } of texts) {
    const keys = [sha256(text), normalizedKey(text)];
    const placed = placementMeta(
      { client: "claude.ai", file: label, text },
      options.classify?.({ client: "claude.ai", file: label, text, name }) ??
        {},
    );
    const item: HarvestItem = {
      source: "claude.ai",
      file: label,
      bytes: Buffer.byteLength(text, "utf8"),
      status: keys.some((key) => ledger[key] || seen.has(key))
        ? "seen"
        : Buffer.byteLength(text, "utf8") > MAX_BYTES
          ? "too-large"
          : "new",
      project: placed.project,
      title: placed.title,
    };
    for (const key of keys) seen.add(key);
    if (item.status === "new" && options.apply)
      try {
        const proposed = await proposeMemory({
          content: text,
          origin: "imported",
          source: "claude.ai",
          reason: label.slice(0, 200),
          target: placed.target,
          meta: placed.meta,
        });
        for (const key of keys) ledger[key] = proposed.candidate;
        item.status = "proposed";
        item.candidate = proposed.candidate;
      } catch (error) {
        if (!(error instanceof MemoryContractError)) throw error;
        item.status = error.code === "SECRET" ? "secret" : "too-large";
      }
    items.push(item);
  }
  if (options.apply) {
    await mkdir(path.dirname(ledgerFile()), { recursive: true, mode: 0o700 });
    await writeFile(ledgerFile(), `${JSON.stringify(ledger, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  return { items, problems };
}
