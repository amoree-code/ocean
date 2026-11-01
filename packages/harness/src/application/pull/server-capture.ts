import { mkdir, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import {
  type Classify,
  type HarvestItem,
  type ImportText,
  proposeImported,
} from "@ocean/brain/memory/memory-harvest.js";
import { atomicWrite } from "@ocean/core/shared/fs-utils.js";
import { serverHistoryDir } from "./history-index.js";

// claude.ai and ChatGPT keep their conversations, projects and memory on their servers (T-305).
// Claude Desktop and the browsers keep what they fetched of those pages in a Chromium HTTP cache;
// `ocean pull` reads it, read-only, and keeps ids, titles, dates and project names in the server
// snapshots the history index reads, and memory or instruction texts as review candidates. Only
// the account pages below are opened; a URL naming a token, OAuth or session is never read.

const WANTED =
  /https:\/\/(?:claude\.ai\/api\/organizations\/|chatgpt\.com\/backend-api\/(?:conversations|gizmos\/snorlax\/sidebar|user_system_messages|memories))[^\s]*/;
const SECRET_URL = /oauth|token|session|auth/i;
// The record that ends each stream of a Chromium "simple cache" entry file.
const EOF_MAGIC = Buffer.from("d8410d97456ffaf4", "hex");
const HEADER_BYTES = 24;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

type Cached = { url: string; at: number; json: unknown };

export type ServerRow = {
  id: string;
  title: string;
  url: string;
  updated?: string;
  project?: string;
  tags?: string[];
};

// Claude Desktop's cache, then every profile of the Chromium browsers.
async function cacheDirs(home: string): Promise<string[]> {
  const dirs = [
    path.join(home, "Library", "Application Support", "Claude", "Cache"),
  ];
  for (const browser of [
    ["Google", "Chrome"],
    ["Arc", "User Data"],
    ["BraveSoftware", "Brave-Browser"],
    ["Microsoft Edge"],
  ]) {
    const root = path.join(home, "Library", "Caches", ...browser);
    for (const profile of await readdir(root).catch((): string[] => []))
      dirs.push(path.join(root, profile, "Cache"));
  }
  return dirs.map((dir) => path.join(dir, "Cache_Data"));
}

function decode(body: Buffer, encoding: string | undefined): string {
  if (encoding === "br") return zlib.brotliDecompressSync(body).toString();
  if (encoding === "gzip") return zlib.gunzipSync(body).toString();
  if (encoding === "deflate") return zlib.inflateSync(body).toString();
  if (encoding === "zstd") {
    const zstd = (zlib as { zstdDecompressSync?: (data: Buffer) => Buffer })
      .zstdDecompressSync;
    if (!zstd) throw new Error("zstd needs Node 22.15");
    return zstd(body).toString();
  }
  return body.toString();
}

// One entry file: the key (its URL) is read first; the body only when the URL is wanted.
async function cachedJson(file: string): Promise<Cached | undefined> {
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const head = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (bytesRead < HEADER_BYTES) return undefined;
    const keyLength = head.readUInt32LE(12);
    const key = head
      .subarray(HEADER_BYTES, Math.min(HEADER_BYTES + keyLength, bytesRead))
      .toString("latin1");
    const url = WANTED.exec(key)?.[0];
    if (!url || SECRET_URL.test(url)) return undefined;
    const data = await readFile(file);
    const start = HEADER_BYTES + keyLength;
    const end = data.indexOf(EOF_MAGIC, start);
    if (end < 0) return undefined;
    const headers = data.subarray(end).toString("latin1").toLowerCase();
    const encoding = /content-encoding:\s*([a-z0-9-]+)/.exec(headers)?.[1];
    const date = /[\0\n]date:\s*([^\0\r\n]+)/.exec(headers)?.[1];
    const json = JSON.parse(decode(data.subarray(start, end), encoding));
    return { url, at: Date.parse(date ?? "") || 0, json };
  } catch {
    // a partial entry, another format or a body that is not JSON
    return undefined;
  } finally {
    await handle.close();
  }
}

// A cache holds tens of thousands of entries; their keys are read a batch at a time.
const BATCH = 128;

async function readCaches(home: string): Promise<Cached[]> {
  const files: string[] = [];
  for (const dir of await cacheDirs(home))
    for (const name of await readdir(dir).catch((): string[] => []))
      if (name.endsWith("_0")) files.push(path.join(dir, name));
  const found: Cached[] = [];
  for (let at = 0; at < files.length; at += BATCH)
    for (const entry of await Promise.all(
      files.slice(at, at + BATCH).map(cachedJson),
    ))
      if (entry) found.push(entry);
  return found;
}

const object = (value: unknown) =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const list = (value: unknown): Record<string, unknown>[] => {
  const items = Array.isArray(value)
    ? value
    : (object(value).data ?? object(value).items);
  return Array.isArray(items) ? items.map(object) : [];
};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const iso = (value: unknown) => {
  const time =
    typeof value === "number"
      ? value < 1e12
        ? value * 1000
        : value
      : Date.parse(text(value));
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
};

type Found = {
  conversations: Map<string, ServerRow & { projectName?: string }>;
  texts: Map<string, { text: string; at: number }>;
};

function claudeAi(entries: Cached[]): Found {
  const names = new Map<string, string>();
  const conversations: Found["conversations"] = new Map();
  const texts: Found["texts"] = new Map();
  for (const { url, json } of entries) {
    if (/\/projects(_v2)?(\?|$)/.test(url))
      for (const project of list(json))
        if (text(project.uuid))
          names.set(text(project.uuid), text(project.name));
    const one = new RegExp(`/projects/(${UUID})(\\?|$)`).exec(url)?.[1];
    if (one && text(object(json).name)) names.set(one, text(object(json).name));
  }
  for (const { url, json, at } of entries) {
    const inProject = new RegExp(`/projects/(${UUID})/conversations_v2`).exec(
      url,
    )?.[1];
    if (inProject || /\/chat_conversations(_v2)?(\?|$)/.test(url))
      for (const row of list(json)) {
        const id = text(row.uuid);
        if (!id) continue;
        const project =
          text(row.project_uuid) || text(object(row.project).uuid) || inProject;
        conversations.set(id, {
          id,
          title: text(row.name),
          url: `https://claude.ai/chat/${id}`,
          updated: iso(row.updated_at),
          projectName:
            (project && names.get(project)) ||
            text(object(row.project).name) ||
            undefined,
        });
      }
    const org = /organizations\/([0-9a-f-]{36})\/memory(\?|$)/.exec(url)?.[1];
    const memory = text(object(json).memory).trim();
    if (org && memory) {
      const label = `claude.ai memory (org ${org.slice(0, 8)})`;
      const updated = Date.parse(text(object(json).updated_at)) || at;
      if (updated >= (texts.get(label)?.at ?? -1))
        texts.set(label, {
          text: `# claude.ai memory\n\n${memory}`,
          at: updated,
        });
    }
  }
  return { conversations, texts };
}

function chatGpt(entries: Cached[]): Found {
  const conversations: Found["conversations"] = new Map();
  const texts: Found["texts"] = new Map();
  const keep = (label: string, body: string, at: number) => {
    if (body.trim() && at >= (texts.get(label)?.at ?? -1))
      texts.set(label, { text: body, at });
  };
  for (const { url, json, at } of entries) {
    const add = (row: Record<string, unknown>, projectName?: string) => {
      const id = text(row.id);
      if (id)
        conversations.set(id, {
          id,
          title: text(row.title),
          url: `https://chatgpt.com/c/${id}`,
          updated: iso(row.update_time),
          projectName: projectName || undefined,
        });
    };
    if (/\/backend-api\/conversations(\?|$)/.test(url))
      for (const row of list(json)) add(row);
    if (url.includes("/gizmos/snorlax/sidebar"))
      for (const item of list(json)) {
        const gizmo = object(object(item.gizmo).gizmo);
        const name = text(object(gizmo.display).name);
        for (const row of list(object(item).conversations)) add(row, name);
      }
    if (url.includes("/user_system_messages")) {
      const about = text(object(json).about_user_message);
      const respond = text(object(json).about_model_message);
      keep(
        "ChatGPT custom instructions",
        `# ChatGPT custom instructions\n\n${about ? `## About me\n\n${about}\n\n` : ""}${respond ? `## How to respond\n\n${respond}\n` : ""}`,
        about || respond ? at : -1,
      );
    }
    if (/\/backend-api\/memories(\?|$)/.test(url)) {
      const lines = list(object(json).memories)
        .map((memory) => text(memory.content).trim())
        .filter(Boolean);
      if (lines.length)
        keep(
          "ChatGPT memory",
          `# ChatGPT memory\n\n${lines.map((line) => `- ${line}`).join("\n")}\n`,
          at,
        );
    }
  }
  return { conversations, texts };
}

const newer = (a?: string, b?: string) =>
  (Date.parse(a ?? "") || 0) >= (Date.parse(b ?? "") || 0) ? a : b;

// A snapshot only grows: what the cache no longer holds stays, and a project set earlier (by hand
// or by a capture) is kept; a newer title or date replaces the old one.
async function mergeSnapshot(
  client: string,
  rows: ServerRow[],
  write: boolean,
): Promise<{ conversations: number; new: number }> {
  const file = path.join(serverHistoryDir(), `${client}.jsonl`);
  const known = new Map<string, ServerRow>();
  for (const line of (await readFile(file, "utf8").catch(() => "")).split("\n"))
    try {
      const row = JSON.parse(line) as ServerRow;
      if (row?.id) known.set(row.id, row);
    } catch {
      // an empty or foreign line
    }
  let added = 0;
  for (const row of rows) {
    const before = known.get(row.id);
    if (!before) added += 1;
    known.set(
      row.id,
      before
        ? {
            ...before,
            title: row.title || before.title,
            updated: newer(row.updated, before.updated),
          }
        : row,
    );
  }
  if (write && rows.length) {
    await mkdir(serverHistoryDir(), { recursive: true, mode: 0o700 });
    await atomicWrite(
      file,
      [...known.values()].map((row) => JSON.stringify(row)).join("\n") +
        (known.size ? "\n" : ""),
      0o600,
    );
  }
  return { conversations: known.size, new: added };
}

export type ServerCapture = {
  snapshots: Record<string, { conversations: number; new: number }>;
  items: HarvestItem[];
};

export async function captureServerHistory(options: {
  home: string;
  apply: boolean;
  classify: Classify;
}): Promise<ServerCapture> {
  const entries = await readCaches(options.home);
  const snapshots: ServerCapture["snapshots"] = {};
  const imports: ImportText[] = [];
  for (const [client, tag, source, found] of [
    [
      "claude-ai",
      "claude.ai",
      "claude.ai",
      claudeAi(entries.filter((entry) => entry.url.includes("claude.ai/"))),
    ],
    [
      "chatgpt",
      "chatgpt",
      "chatgpt",
      chatGpt(entries.filter((entry) => entry.url.includes("chatgpt.com/"))),
    ],
  ] as const) {
    const rows = [...found.conversations.values()].map(
      ({ projectName, ...row }): ServerRow => {
        // A conversation in a provider project goes where that project's name points.
        const project = projectName
          ? options.classify({
              client: source,
              file: row.url,
              text: "",
              name: projectName,
            }).project
          : undefined;
        return {
          ...row,
          project: project ?? "unassigned",
          tags: projectName ? [tag, projectName] : [tag],
        };
      },
    );
    snapshots[client] = await mergeSnapshot(client, rows, options.apply);
    for (const [label, { text: body }] of found.texts)
      imports.push({ label, text: body, source });
  }
  const items = await proposeImported(imports, {
    apply: options.apply,
    classify: options.classify,
  });
  return { snapshots, items };
}
