import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { DesktopConversation, DesktopMessage } from "./desktop-chat.js";

// The official claude.ai data export (Settings → Privacy → Export) as a source for the same
// capture as Desktop chat (T-315): `conversations.json` holds every conversation, from any
// device, as `{uuid, updated_at, chat_messages: [{uuid, sender, text, content, created_at}]}`.
// Messages are in order and carry no index, so the cursor is the message's creation time,
// which the Desktop store carries too: a conversation read from either is read once.

export class ClaudeExportError extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isoDate(value: unknown): string {
  if (typeof value !== "string") return "";
  const time = Date.parse(value);
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

function messageText(message: Record<string, unknown>): string {
  if (Array.isArray(message.content)) {
    const text = message.content
      .filter(
        (block) =>
          isObject(block) &&
          block.type === "text" &&
          typeof block.text === "string",
      )
      .map((block) => (block as { text: string }).text.trim())
      .filter(Boolean)
      .join("\n\n");
    if (text) return text;
  }
  return typeof message.text === "string" ? message.text.trim() : "";
}

export function exportConversation(raw: unknown): DesktopConversation | null {
  if (!isObject(raw) || typeof raw.uuid !== "string") return null;
  if (!Array.isArray(raw.chat_messages)) return null;
  const messages: DesktopMessage[] = [];
  raw.chat_messages.forEach((value, index) => {
    if (!isObject(value)) return;
    const sender = value.sender;
    if (sender !== "human" && sender !== "assistant") return;
    messages.push({
      uuid:
        typeof value.uuid === "string" ? value.uuid : `${raw.uuid}#${index}`,
      index,
      sender,
      text: messageText(value),
      createdAt: isoDate(value.created_at),
    });
  });
  return {
    uuid: raw.uuid,
    updatedAt: isoDate(raw.updated_at) || (messages.at(-1)?.createdAt ?? ""),
    messageCount: messages.length,
    messages,
  };
}

// Every conversation in an unpacked export folder, newest first.
export async function readExportChats(directory: string): Promise<{
  status: "ok";
  conversations: DesktopConversation[];
  skipped: number;
}> {
  const file = path.join(directory, "conversations.json");
  if (!(await stat(file).catch(() => null)))
    throw new ClaudeExportError(`conversations.json not found in ${directory}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new ClaudeExportError("conversations.json is not valid JSON");
  }
  if (!Array.isArray(parsed))
    throw new ClaudeExportError("conversations.json is not a list");
  const conversations: DesktopConversation[] = [];
  let skipped = 0;
  for (const raw of parsed) {
    const conversation = exportConversation(raw);
    if (conversation) conversations.push(conversation);
    else skipped++;
  }
  conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { status: "ok", conversations, skipped };
}
