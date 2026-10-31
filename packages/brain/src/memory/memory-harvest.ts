import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryContractError } from "@ocean/core/domain/mcp/memory-contract.js";
import { sha256 } from "./memory-audit.js";
import { harvestLedgerFile, stagingDir } from "./memory-paths.js";
import { proposeMemory } from "./memory-write.js";

// One-time and repeatable harvest of clients' own memory stores into candidates (T-296 §3.5,
// P4). A harvested file never becomes a record by itself: it is proposed (origin `imported`)
// for the owner's review, through proposeMemory's checks (size, secrets). A ledger of content
// hashes keeps a rerun from proposing the same text twice. The dry run names files and sizes,
// never their content.

export type HarvestSource =
  | "claude-code"
  | "codex"
  | "gemini"
  | "hermes"
  | "antigravity";

export const HARVEST_SOURCES: HarvestSource[] = [
  "claude-code",
  "codex",
  "gemini",
  "hermes",
  "antigravity",
];

export type HarvestItem = {
  source: HarvestSource;
  file: string;
  bytes: number;
  status: "new" | "seen" | "too-large" | "secret" | "proposed";
  candidate?: string;
};

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
    return read(await filesIn(path.join(home, ".codex", "memories")));
  if (source === "hermes")
    return read(await filesIn(path.join(home, ".hermes", "memories")));
  if (source === "antigravity")
    return read(
      await filesIn(path.join(home, ".gemini", "antigravity", "brain"), 1),
    );
  const texts = await read(await filesIn(path.join(home, ".gemini", "memory")));
  // Gemini's save_memory appends under this heading in GEMINI.md.
  const geminiMd = path.join(home, ".gemini", "GEMINI.md");
  const section =
    /^## Gemini Added Memories\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(
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
  options: { sources?: HarvestSource[]; apply?: boolean; home?: string } = {},
): Promise<HarvestItem[]> {
  const home = options.home ?? os.homedir();
  const ledger = await readLedger();
  const items: HarvestItem[] = [];
  const shown = (file: string) =>
    file.startsWith(home) ? `~${file.slice(home.length)}` : file;
  for (const source of options.sources ?? HARVEST_SOURCES) {
    for (const { file, text } of await sourceTexts(source, home)) {
      const bytes = Buffer.byteLength(text, "utf8");
      const hash = sha256(text);
      const item: HarvestItem = {
        source,
        file: shown(file),
        bytes,
        status: "new",
      };
      if (!text.trim()) continue;
      if (ledger[hash]) item.status = "seen";
      else if (bytes > MAX_BYTES) item.status = "too-large";
      else if (options.apply)
        try {
          const proposed = await proposeMemory({
            content: text,
            origin: "imported",
            source,
            reason: `harvested from ${shown(file)}`.slice(0, 200),
          });
          ledger[hash] = proposed.candidate;
          item.status = "proposed";
          item.candidate = proposed.candidate;
        } catch (error) {
          if (!(error instanceof MemoryContractError)) throw error;
          item.status = error.code === "SECRET" ? "secret" : "too-large";
        }
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
  options: { apply?: boolean } = {},
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
  const texts: { label: string; text: string }[] = [];
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
    });
    for (const doc of Array.isArray(raw.docs) ? raw.docs : [])
      if (typeof doc?.content === "string" && doc.content.trim())
        texts.push({
          label: `claude.ai project ${name} doc ${String(doc.filename ?? "")}`,
          text: doc.content,
        });
  }
  for (const { label, text } of texts) {
    const hash = sha256(text);
    const item: HarvestItem = {
      source: "claude-code",
      file: label,
      bytes: Buffer.byteLength(text, "utf8"),
      status: ledger[hash]
        ? "seen"
        : Buffer.byteLength(text, "utf8") > MAX_BYTES
          ? "too-large"
          : "new",
    };
    if (item.status === "new" && options.apply)
      try {
        const proposed = await proposeMemory({
          content: text,
          origin: "imported",
          source: "claude.ai",
          reason: label.slice(0, 200),
        });
        ledger[hash] = proposed.candidate;
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
