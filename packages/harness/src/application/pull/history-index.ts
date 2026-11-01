import { createReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Transform } from "node:stream";
import zlib from "node:zlib";
import { redactSecrets } from "@ocean/core/domain/redaction/redaction.js";
import { atomicWrite } from "@ocean/core/shared/fs-utils.js";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { loadProjectIndex, placeFolder } from "./project-match.js";

// Every AI client's conversation history, indexed — never copied (T-305). One line per
// conversation: which client, which of the owner's projects (by its folder), when, a short title
// (the stored one or the first prompt, secrets redacted) and where its transcript lives. The
// transcripts stay where each client keeps them; `ocean pull search` finds one and names its file.
// A conversation Claude Desktop ran through Claude Code is one line, marked `alsoIn`.

export type HistoryEntry = {
  client: string;
  project: string;
  tags?: string[];
  pull: true;
  date: string;
  title: string;
  file: string;
  cwd?: string;
  id: string;
  updated: string;
  pulled_at: string;
  bytes: number;
  alsoIn?: string[];
  // The Claude Code session a Claude Desktop entry ran.
  cliSession?: string;
  // Size and modification time when parsed: an unchanged file is not read again.
  version: string;
};

const HEAD_BYTES = 64 * 1024;
const TITLE_CHARS = 120;

export const historyIndexFile = () =>
  oceanPath(SYSTEM_DIR, "state", "history", "sessions.jsonl");

function title(text: unknown): string {
  if (typeof text !== "string") return "";
  return redactSecrets(text.replace(/\s+/g, " ").trim()).slice(0, TITLE_CHARS);
}

// The texts of a chat message's content: a string, or the text parts of a list.
function contentTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) =>
    part && typeof part === "object" && typeof part.text === "string"
      ? [part.text]
      : [],
  );
}

// What the owner asked: the first message text left once injected context (leading
// `<tag>…</tag>` blocks: environment, opened file, reminders, command echoes) is taken off.
const LEADING_BLOCK = /^\s*<([A-Za-z][\w-]*)[^>]*>[\s\S]*?<\/\1>/;
function firstPrompt(contents: unknown[]): string | undefined {
  for (const content of contents)
    for (let text of contentTexts(content)) {
      while (LEADING_BLOCK.test(text)) text = text.replace(LEADING_BLOCK, "");
      if (text.trim() && !/^\s*(<|# AGENTS\.md|Caveat:)/.test(text))
        return text;
    }
  return undefined;
}

// Codex compresses older sessions (`.jsonl.zst`); zstd is in node:zlib from Node 22.15. Without
// it such a file is still indexed, untitled.
const zstd = (zlib as { createZstdDecompress?: () => Transform })
  .createZstdDecompress;

async function zstdHead(file: string, bytes: number): Promise<string[]> {
  if (!zstd) return [];
  const chunks: Buffer[] = [];
  let size = 0;
  const source = createReadStream(file);
  const stream = source.pipe(zstd());
  try {
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
      size += (chunk as Buffer).length;
      if (size >= bytes) break;
    }
  } finally {
    source.destroy();
    stream.destroy();
  }
  const lines = Buffer.concat(chunks)
    .subarray(0, bytes)
    .toString("utf8")
    .split("\n");
  return size >= bytes ? lines.slice(0, -1) : lines;
}

async function head(file: string, bytes = HEAD_BYTES): Promise<string[]> {
  if (file.endsWith(".zst")) return zstdHead(file, bytes);
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    // The last line may be cut off mid-record.
    return bytesRead === bytes ? lines.slice(0, -1) : lines;
  } finally {
    await handle.close();
  }
}

// The end of a long transcript, where titles set later in the session are appended.
async function tail(file: string): Promise<string[]> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    if (size <= HEAD_BYTES) return [];
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      HEAD_BYTES,
      size - HEAD_BYTES,
    );
    // The first line may start mid-record.
    return buffer.subarray(0, bytesRead).toString("utf8").split("\n").slice(1);
  } finally {
    await handle.close();
  }
}

function records(lines: string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object") out.push(value);
    } catch {
      // a partial or foreign line
    }
  }
  return out;
}

async function filesUnder(
  directory: string,
  match: (name: string) => boolean,
  depth: number,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  const found: string[] = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isFile() && match(entry.name)) found.push(target);
    else if (depth > 0 && entry.isDirectory() && !entry.name.startsWith("."))
      found.push(...(await filesUnder(target, match, depth - 1)));
  }
  return found;
}

type Parsed = {
  id?: string;
  cwd?: string;
  updated?: string;
  title?: string;
  cliSession?: string;
};
type Reader = {
  client: string;
  files(home: string): Promise<string[]>;
  parse(file: string): Promise<Parsed>;
};

const at = (value: unknown) => {
  const time =
    typeof value === "number" ? value : Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
};
const object = (value: unknown) =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const readers: Reader[] = [
  {
    client: "claude-code",
    files: (home) =>
      filesUnder(
        path.join(home, ".claude", "projects"),
        (name) => name.endsWith(".jsonl"),
        1,
      ),
    async parse(file) {
      const lines = records(await head(file));
      const end = records(await tail(file));
      // The title the owner set, then Claude Code's own, then the first prompt.
      const named = (type: string, key: string) =>
        [...lines, ...end].reverse().find((line) => line.type === type)?.[key];
      const prompt = firstPrompt(
        lines
          .filter((line) => line.type === "user" && !line.isMeta)
          .map((line) => object(line.message).content),
      );
      return {
        cwd: lines.find((line) => typeof line.cwd === "string")?.cwd as
          | string
          | undefined,
        title: title(
          named("custom-title", "customTitle") ??
            named("ai-title", "aiTitle") ??
            named("summary", "summary") ??
            prompt,
        ),
      };
    },
  },
  {
    client: "codex",
    files: (home) =>
      filesUnder(
        path.join(home, ".codex", "sessions"),
        (name) => name.startsWith("rollout-") && /\.jsonl(\.zst)?$/.test(name),
        4,
      ),
    async parse(file) {
      // The first prompt follows tens of kilobytes of instructions and injected context.
      const lines = records(await head(file, 4 * HEAD_BYTES));
      const meta = object(
        lines.find((line) => line.type === "session_meta")?.payload,
      );
      const prompt = firstPrompt(
        lines
          .map((line) => object(line.payload))
          .filter((item) => item.type === "message" && item.role === "user")
          .map((item) => item.content),
      );
      return {
        id: typeof meta.id === "string" ? meta.id : undefined,
        cwd: typeof meta.cwd === "string" ? meta.cwd : undefined,
        title: title(prompt),
      };
    },
  },
  {
    // Codex's own one-page summary of each past session.
    client: "codex-summary",
    files: (home) =>
      filesUnder(
        path.join(home, ".codex", "memories", "rollout_summaries"),
        (name) => name.endsWith(".md"),
        0,
      ),
    async parse(file) {
      const slug = path
        .basename(file, ".md")
        .replace(/^\d{4}-\d\d-\d\dT[\d-]+-[^-]+-/, "");
      return { title: title(slug.replace(/_/g, " ")) };
    },
  },
  {
    client: "gemini",
    files: (home) =>
      filesUnder(
        path.join(home, ".gemini", "tmp"),
        (name) => name.startsWith("session") && name.endsWith(".jsonl"),
        2,
      ),
    async parse(file) {
      // One `$set` line can hold every message so far: read the whole file, within a bound.
      const lines = records(await head(file, 32 * HEAD_BYTES));
      const first = lines[0] ?? {};
      const root = await readFile(
        path.join(path.dirname(path.dirname(file)), ".project_root"),
        "utf8",
      ).catch(() => "");
      // Messages are lines of their own, or batched under `$set.messages`.
      const messages = lines.flatMap((line) => {
        const batch = object(line.$set).messages;
        return Array.isArray(batch) ? batch.map(object) : [line];
      });
      const prompt = firstPrompt(
        messages
          .filter((message) => message.type === "user")
          .map((message) => message.content),
      );
      return {
        id: typeof first.sessionId === "string" ? first.sessionId : undefined,
        cwd: root.trim() || undefined,
        updated: at(first.lastUpdated),
        title: title(prompt),
      };
    },
  },
  {
    client: "cursor",
    files: (home) =>
      filesUnder(
        path.join(home, ".cursor", "chats"),
        (name) => name === "meta.json",
        2,
      ),
    async parse(file) {
      const meta = object(JSON.parse(await readFile(file, "utf8")));
      return {
        id: path.basename(path.dirname(file)),
        cwd: typeof meta.cwd === "string" ? meta.cwd : undefined,
        updated: at(meta.updatedAtMs),
        title: title(meta.title),
      };
    },
  },
  {
    // Claude Desktop's Code sessions; their transcripts are Claude Code's, under ~/.claude.
    client: "claude-desktop",
    files: (home) =>
      filesUnder(
        path.join(
          home,
          "Library",
          "Application Support",
          "Claude",
          "claude-code-sessions",
        ),
        (name) => name.startsWith("local_") && name.endsWith(".json"),
        2,
      ),
    async parse(file) {
      const session = object(JSON.parse(await readFile(file, "utf8")));
      return {
        id:
          typeof session.sessionId === "string" ? session.sessionId : undefined,
        cwd: typeof session.cwd === "string" ? session.cwd : undefined,
        updated: at(session.lastActivityAt),
        title: title(session.title),
        cliSession:
          typeof session.cliSessionId === "string"
            ? session.cliSessionId
            : undefined,
      };
    },
  },
];

// OpenCode keeps its sessions in one SQLite file; each row is a conversation.
async function openCodeEntries(
  home: string,
): Promise<(Parsed & { file: string; version: string })[]> {
  const file = path.join(home, ".local", "share", "opencode", "opencode.db");
  if (!(await stat(file).catch(() => null))) return [];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db
      .prepare("select id, title, directory, time_updated from session")
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      file: `${file}#${String(row.id)}`,
      cwd: typeof row.directory === "string" ? row.directory : undefined,
      updated: at(row.time_updated),
      title: title(row.title),
      version: String(row.time_updated),
    }));
  } catch {
    // another schema or a locked file: nothing indexed this time
    return [];
  } finally {
    db?.close();
  }
}

async function readIndex(): Promise<HistoryEntry[]> {
  const text = await readFile(historyIndexFile(), "utf8").catch(() => "");
  return records(text.split("\n")) as HistoryEntry[];
}

// Rebuilds the index; a transcript whose size and time are unchanged is not read again, so a
// daily run reads only what is new. Projects are matched afresh every time: a folder bound since
// the last run moves its conversations.
export async function buildHistoryIndex(
  options: { home?: string; write?: boolean } = {},
): Promise<HistoryEntry[]> {
  const home = options.home ?? os.homedir();
  const shown = (file: string) =>
    file.startsWith(home) ? `~${file.slice(home.length)}` : file;
  const previous = new Map(
    (await readIndex()).map((entry) => [entry.file, entry]),
  );
  const projects = await loadProjectIndex(home);
  const pulledAt = new Date().toISOString();
  const entries: HistoryEntry[] = [];
  const add = (
    client: string,
    file: string,
    parsed: Parsed,
    fallback: { updated: string; bytes: number; version: string },
  ) => {
    const place = placeFolder(projects, parsed.cwd);
    const known = previous.get(file);
    const updated = parsed.updated ?? fallback.updated;
    entries.push({
      client,
      project: place.project ?? "unassigned",
      ...(place.tags?.length ? { tags: place.tags } : {}),
      pull: true,
      date: updated.slice(0, 10),
      title: parsed.title ?? "",
      file,
      ...(place.cwd ? { cwd: place.cwd } : {}),
      id:
        parsed.id ??
        path.basename(file).replace(/\.jsonl(\.zst)?$|\.[^.]+$/, ""),
      updated,
      // First seen, kept across runs.
      pulled_at: known?.pulled_at ?? pulledAt,
      bytes: fallback.bytes,
      ...(parsed.cliSession ? { cliSession: parsed.cliSession } : {}),
      version: fallback.version,
    });
  };
  for (const reader of readers)
    for (const file of await reader.files(home)) {
      const info = await stat(file).catch(() => null);
      if (!info) continue;
      const version = `${info.size}:${info.mtimeMs}`;
      const known = previous.get(shown(file));
      const parsed: Parsed =
        known?.client === reader.client && known.version === version
          ? {
              id: known.id,
              cwd: known.cwd,
              updated: known.updated,
              title: known.title,
              cliSession: known.cliSession,
            }
          : await reader.parse(file).catch((): Parsed => ({}));
      add(reader.client, shown(file), parsed, {
        updated: info.mtime.toISOString(),
        bytes: info.size,
        version,
      });
    }
  for (const row of await openCodeEntries(home))
    add("opencode", shown(row.file), row, {
      updated: new Date(0).toISOString(),
      bytes: 0,
      version: row.version,
    });
  // Claude Desktop's Code sessions are Claude Code sessions: one line, marked.
  const claudeCode = new Map(
    entries
      .filter((entry) => entry.client === "claude-code")
      .map((entry) => [entry.id, entry]),
  );
  const merged = entries.filter((entry) => {
    const same =
      entry.client === "claude-desktop" && entry.cliSession
        ? claudeCode.get(entry.cliSession)
        : undefined;
    if (!same) return true;
    same.alsoIn = ["claude-desktop"];
    if (!same.title) same.title = entry.title;
    return false;
  });
  merged.sort((a, b) => b.updated.localeCompare(a.updated));
  if (options.write) {
    await mkdir(path.dirname(historyIndexFile()), {
      recursive: true,
      mode: 0o700,
    });
    await atomicWrite(
      historyIndexFile(),
      merged.map((entry) => JSON.stringify(entry)).join("\n") +
        (merged.length ? "\n" : ""),
      0o600,
    );
  }
  return merged;
}

// Every word must appear in the title, project, tags, folder, client or file; newest first.
export async function searchHistory(
  query: string,
  options: { client?: string; project?: string; limit?: number } = {},
): Promise<HistoryEntry[]> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return (await readIndex())
    .filter((entry) => !options.client || entry.client === options.client)
    .filter((entry) => !options.project || entry.project === options.project)
    .filter((entry) => {
      const text = [
        entry.title,
        entry.project,
        ...(entry.tags ?? []),
        entry.cwd ?? "",
        entry.client,
        entry.file,
      ]
        .join(" ")
        .toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .slice(0, options.limit ?? 20);
}
