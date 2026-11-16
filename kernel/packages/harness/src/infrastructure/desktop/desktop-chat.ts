import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readIndexedDb } from "./indexeddb.js";

// Claude Desktop's plain chat, read from the app's own IndexedDB (T-315). The app keeps the
// conversations it has open or opened recently in the "trees" object store of its claude.ai
// origin: one record per conversation, holding the message tree. The format is undocumented
// and may change with any app update, so any surprise ends in DesktopChatUnreadable, and a
// record that does not decode is skipped. Read-only: the LevelDB folder is copied aside and the
// copy is read; the app's LOCK is never taken and nothing in its folders is written.

export const DESKTOP_CHAT_UNREADABLE = "DESKTOP_CHAT_UNREADABLE";

export class DesktopChatUnreadable extends Error {
  readonly code = DESKTOP_CHAT_UNREADABLE;
}

export type DesktopMessage = {
  uuid: string;
  index: number;
  sender: "human" | "assistant";
  text: string;
  createdAt: string;
};

export type DesktopConversation = {
  uuid: string;
  updatedAt: string;
  messageCount: number;
  messages: DesktopMessage[];
};

export type DesktopChatRead =
  | { status: "absent" }
  | { status: "ok"; conversations: DesktopConversation[]; skipped: number };

const ORIGIN = "https_claude.ai_0.indexeddb";
const TREES_STORE = "trees";
const ROOT_PARENT = "00000000-0000-4000-8000-000000000000";
const LEVELDB_FILE = /^(CURRENT|MANIFEST-\d+|\d+\.(log|ldb|sst))$/;

// Where Claude Desktop keeps its IndexedDB: the app's user-data folder on each platform.
export function desktopIndexedDbDir(
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32")
    return path.join(
      process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
      "Claude",
      "IndexedDB",
    );
  if (platform === "darwin")
    return path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "IndexedDB",
    );
  return path.join(home, ".config", "Claude", "IndexedDB");
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isoDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value))
    return new Date(value).toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value)))
    return new Date(value).toISOString();
  if (value instanceof Date && !Number.isNaN(value.getTime()))
    return value.toISOString();
  return null;
}

// The text of a message: its `text` blocks only. Thinking, tool calls, tool results and
// attachments are left out.
function messageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block) =>
        isObject(block) &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => (block as { text: string }).text.trim())
    .filter(Boolean)
    .join("\n\n");
}

type RawMessage = DesktopMessage & { parent: string | null };

function rawMessage(value: unknown): RawMessage | null {
  if (!isObject(value)) return null;
  const { uuid, sender, index } = value;
  if (typeof uuid !== "string" || typeof index !== "number") return null;
  if (sender !== "human" && sender !== "assistant") return null;
  return {
    uuid,
    index,
    sender,
    text: messageText(value.content),
    createdAt: isoDate(value.created_at) ?? "",
    parent:
      typeof value.parent_message_uuid === "string"
        ? value.parent_message_uuid
        : null,
  };
}

// An edited or retried message leaves sibling branches in the tree. The conversation is the
// branch that ends at the newest leaf: highest index, then latest creation.
export function currentBranch(all: RawMessage[]): DesktopMessage[] {
  const byUuid = new Map(all.map((message) => [message.uuid, message]));
  const parents = new Set(all.map((message) => message.parent));
  const leaves = all.filter((message) => !parents.has(message.uuid));
  leaves.sort(
    (a, b) => b.index - a.index || b.createdAt.localeCompare(a.createdAt),
  );
  const branch: DesktopMessage[] = [];
  const seen = new Set<string>();
  let cursor: RawMessage | undefined = leaves[0];
  while (cursor && !seen.has(cursor.uuid)) {
    seen.add(cursor.uuid);
    const { parent, ...message }: RawMessage = cursor;
    branch.push(message);
    cursor = parent && parent !== ROOT_PARENT ? byUuid.get(parent) : undefined;
  }
  return branch.reverse();
}

export function conversationFromRecord(
  value: unknown,
): DesktopConversation | null {
  if (!isObject(value) || typeof value.conversationUuid !== "string")
    return null;
  const tree = value.tree;
  if (!isObject(tree) || !Array.isArray(tree.messages)) return null;
  const raw = tree.messages
    .map(rawMessage)
    .filter((m): m is RawMessage => m !== null);
  const messages = currentBranch(raw);
  const updatedAt =
    isoDate(value.conversationUpdatedAt) ??
    messages.at(-1)?.createdAt ??
    isoDate(value.writtenAt) ??
    "";
  return {
    uuid: value.conversationUuid,
    updatedAt,
    messageCount: messages.length,
    messages,
  };
}

// Copy the LevelDB files aside. A compaction can delete a file between listing and copying;
// then the copy starts over.
async function snapshot(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      for (const name of (await readdir(source)).filter((n) =>
        LEVELDB_FILE.test(n),
      ))
        await copyFile(path.join(source, name), path.join(target, name));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt >= 2)
        throw error;
    }
  }
}

export async function readDesktopChats(
  indexedDbDir = desktopIndexedDbDir(),
): Promise<DesktopChatRead> {
  const leveldb = path.join(indexedDbDir, `${ORIGIN}.leveldb`);
  const blobs = path.join(indexedDbDir, `${ORIGIN}.blob`);
  try {
    await readdir(leveldb);
  } catch {
    return { status: "absent" };
  }
  const copy = await mkdtemp(path.join(os.tmpdir(), "ocean-desktop-"));
  try {
    await snapshot(leveldb, copy);
    const { records, skipped } = await readIndexedDb(
      copy,
      blobs,
      (store) => store === TREES_STORE,
    );
    const newest = new Map<string, DesktopConversation>();
    let unshaped = 0;
    for (const record of records) {
      const conversation = conversationFromRecord(record.value);
      if (!conversation) {
        unshaped++;
        continue;
      }
      const seen = newest.get(conversation.uuid);
      if (!seen || seen.updatedAt < conversation.updatedAt)
        newest.set(conversation.uuid, conversation);
    }
    if (newest.size === 0 && skipped + unshaped > 0)
      throw new DesktopChatUnreadable(
        `${skipped + unshaped} conversation record(s) found, none readable`,
      );
    return {
      status: "ok",
      conversations: [...newest.values()].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
      skipped: skipped + unshaped,
    };
  } catch (error) {
    if (error instanceof DesktopChatUnreadable) throw error;
    throw new DesktopChatUnreadable((error as Error).message);
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}
