import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runDesktopFacts } from "@ocean/loop/hooks/desktop-facts.js";
import {
  ClaudeExportError,
  readExportChats,
} from "../dist/infrastructure/desktop/claude-export.js";

// The official claude.ai export as a capture source (T-315). Synthetic data only.

const at = (second) =>
  new Date(Date.UTC(2025, 11, 31, 0, 0, second)).toISOString();

function exportConversation(uuid, texts) {
  return {
    uuid,
    name: "untitled",
    updated_at: at(texts.length),
    chat_messages: texts.map((text, index) => ({
      uuid: `${uuid}-${index}`,
      sender: index % 2 ? "assistant" : "human",
      text: index === 0 ? "" : text,
      // The first message keeps its text only in content blocks; the rest only in `text`.
      content: index === 0 ? [{ type: "text", text }] : [],
      created_at: at(index),
    })),
  };
}

async function exportFolder(conversations) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-export-"));
  await writeFile(
    path.join(dir, "conversations.json"),
    JSON.stringify(conversations),
  );
  return dir;
}

test("reads conversations.json in message order, newest conversation first", async () => {
  const dir = await exportFolder([
    exportConversation("a", ["hi", "hello"]),
    exportConversation("b", ["one", "two", "three"]),
    { uuid: "broken" },
  ]);
  const read = await readExportChats(dir);
  assert.equal(read.skipped, 1);
  assert.deepEqual(
    read.conversations.map((c) => c.uuid),
    ["b", "a"],
  );
  assert.deepEqual(
    read.conversations[0].messages.map((m) => [m.sender, m.text]),
    [
      ["human", "one"],
      ["assistant", "two"],
      ["human", "three"],
    ],
  );
  await assert.rejects(
    readExportChats(path.join(dir, "missing")),
    ClaudeExportError,
  );
});

test("a conversation read from the app is not read again from the export", async () => {
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = await mkdtemp(
    path.join(os.tmpdir(), "ocean-export-root-"),
  );
  try {
    const prompts = [];
    const complete = async (prompt) => {
      prompts.push(prompt);
      return '{"facts": []}';
    };
    const enabled = async () => true;
    const now = new Date("2026-01-01T00:00:00.000Z");
    // The app held the first two turns.
    const app = async () => ({
      status: "ok",
      conversations: [
        {
          uuid: "c",
          updatedAt: at(1),
          messages: [
            { createdAt: at(0), sender: "human", text: "I deploy on Fridays" },
            { createdAt: at(1), sender: "assistant", text: "Noted." },
          ],
        },
      ],
    });
    await runDesktopFacts({ read: app, complete, now, enabled });
    assert.equal(prompts.length, 1);

    // The export has the same two turns and two more, written on another device.
    const dir = await exportFolder([
      exportConversation("c", [
        "I deploy on Fridays",
        "Noted.",
        "I prefer tabs",
        "OK.",
      ]),
    ]);
    const run = await runDesktopFacts({
      read: () => readExportChats(dir),
      complete,
      now,
      quietMs: 0,
      enabled,
    });
    assert.equal(run.runs.length, 1);
    assert.equal(prompts.length, 2);
    assert.doesNotMatch(prompts[1], /Fridays/);
    assert.match(prompts[1], /tabs/);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});
