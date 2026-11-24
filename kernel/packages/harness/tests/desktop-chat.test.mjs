import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import v8 from "node:v8";
import {
  conversationFromRecord,
  DesktopChatUnreadable,
  messageText,
  readDesktopChats,
  TOOL_RESULT_CHARS,
} from "../dist/infrastructure/desktop/desktop-chat.js";
import { unsnappy } from "../dist/infrastructure/desktop/snappy.js";

// A tiny writer for the formats the reader decodes (T-315): LevelDB log, table and MANIFEST,
// Chromium IndexedDB keys and value wrappers, a blob file. Synthetic data only.

const varint = (n) => {
  const out = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
};
const withLength = (buf) => Buffer.concat([varint(buf.length), buf]);
const utf16be = (s) => Buffer.from(s, "utf16le").swap16();

// Snappy: literals in chunks of up to 60 bytes, plus one copy when asked (for the copy path).
function snappy(raw) {
  const parts = [varint(raw.length)];
  for (let i = 0; i < raw.length; i += 60) {
    const chunk = raw.subarray(i, i + 60);
    parts.push(Buffer.from([(chunk.length - 1) << 2]), chunk);
  }
  return Buffer.concat(parts);
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function masked(data) {
  let crc = 0xffffffff;
  for (const b of data) crc = CRC[(crc ^ b) & 0xff] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}
// Log format, each record FULL and well inside one block.
function logFile(records) {
  return Buffer.concat(
    records.map((data) => {
      const header = Buffer.alloc(7);
      header.writeUInt16LE(data.length, 4);
      header[6] = 1;
      header.writeUInt32LE(masked(Buffer.concat([Buffer.from([1]), data])), 0);
      return Buffer.concat([header, data]);
    }),
  );
}
function batch(sequence, ops) {
  const head = Buffer.alloc(12);
  head.writeBigUInt64LE(BigInt(sequence), 0);
  head.writeUInt32LE(ops.length, 8);
  return Buffer.concat([
    head,
    ...ops.map(([key, value]) =>
      value === null
        ? Buffer.concat([Buffer.from([0]), withLength(key)])
        : Buffer.concat([Buffer.from([1]), withLength(key), withLength(value)]),
    ),
  ]);
}
function block(entries) {
  const body = Buffer.concat(
    entries.map(([key, value]) =>
      Buffer.concat([
        varint(0),
        varint(key.length),
        varint(value.length),
        key,
        value,
      ]),
    ),
  );
  const restarts = Buffer.alloc(8);
  restarts.writeUInt32LE(0, 0);
  restarts.writeUInt32LE(1, 4);
  return Buffer.concat([body, restarts]);
}
// One snappy-compressed data block, an index block, an empty metaindex, the footer.
function tableFile(entries) {
  const parts = [];
  let offset = 0;
  const add = (raw, compression) => {
    const handle = Buffer.concat([varint(offset), varint(raw.length)]);
    parts.push(raw, Buffer.from([compression, 0, 0, 0, 0]));
    offset += raw.length + 5;
    return handle;
  };
  const data = add(snappy(block(entries)), 1);
  const meta = add(block([]), 0);
  const index = add(block([[entries.at(-1)[0], data]]), 0);
  const footer = Buffer.alloc(48);
  Buffer.concat([meta, index]).copy(footer);
  footer.writeBigUInt64LE(0xdb4775248b80fb57n, 40);
  return Buffer.concat([...parts, footer]);
}
const internal = (key, sequence) => {
  const tail = Buffer.alloc(8);
  tail.writeBigUInt64LE((BigInt(sequence) << 8n) | 1n);
  return Buffer.concat([key, tail]);
};

const DB = 1;
const STORE = 1;
const storeName = (name) => [
  Buffer.from([0, DB, 0, 0, 50, STORE, 0]),
  utf16be(name),
];
const recordKey = (uuid, index = 1) =>
  Buffer.concat([
    Buffer.from([0, DB, STORE, index, 1]),
    varint(uuid.length),
    utf16be(uuid),
  ]);

// Blink value around V8's, the V8 version byte set to 16 as Desktop writes it.
function blink(value) {
  const v8bytes = v8.serialize(value);
  v8bytes[1] = 16;
  return Buffer.concat([
    Buffer.from([0xff, 0x15, 0xfe]),
    Buffer.alloc(12),
    v8bytes,
  ]);
}
const plain = (value) => Buffer.concat([varint(1), blink(value)]);
const compressed = (value) =>
  Buffer.concat([
    varint(1),
    Buffer.from([0xff, 0x11, 0x02]),
    snappy(blink(value)),
  ]);

const ROOT = "00000000-0000-4000-8000-000000000000";
function conversation(uuid, turns, updated = "2026-01-02T00:00:00.000Z") {
  let parent = ROOT;
  const messages = turns.map(([sender, text], index) => {
    const id = `${uuid}-m${index}`;
    const message = {
      uuid: id,
      sender,
      index,
      parent_message_uuid: parent,
      content: [
        { type: "thinking", thinking: "internal" },
        { type: "text", text },
      ],
      created_at: `2026-01-01T00:00:0${index}.000Z`,
    };
    parent = id;
    return message;
  });
  return {
    conversationUuid: uuid,
    product: "hub",
    conversationUpdatedAt: Date.parse(updated),
    messageCount: messages.length,
    tree: { kind: "hub_transcript", messages },
  };
}

async function fakeStore({ corruptOnly = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-desktop-test-"));
  const leveldb = path.join(root, "https_claude.ai_0.indexeddb.leveldb");
  const blobDir = path.join(root, "https_claude.ai_0.indexeddb.blob");
  await mkdir(leveldb);
  await mkdir(path.join(blobDir, "1", "01"), { recursive: true });

  const broken = Buffer.concat([
    varint(1),
    Buffer.from([0xff, 0x15, 0x00, 0x01]),
  ]);
  const tableEntries = corruptOnly
    ? [[recordKey("c-bad"), broken]]
    : [
        [recordKey("c-blob"), Buffer.alloc(0)], // replaced below by the blob wrapper
        [
          recordKey("c-deleted"),
          plain(conversation("c-deleted", [["human", "gone"]])),
        ],
        [
          recordKey("c-old"),
          plain(conversation("c-old", [["human", "first version"]])),
        ],
        [
          recordKey("c-table"),
          compressed(
            conversation("c-table", [
              ["human", "hello table"],
              ["assistant", "hi"],
            ]),
          ),
        ],
      ];
  const blobNumber = 0x1a3;
  const blobValue = Buffer.concat([
    Buffer.from([0xff, 0x11, 0x02]),
    snappy(
      blink(
        conversation("c-blob", [
          ["human", "stored in a blob"],
          ["assistant", "ok"],
          ["human", "more"],
        ]),
      ),
    ),
  ]);
  await writeFile(
    path.join(blobDir, "1", "01", blobNumber.toString(16)),
    blobValue,
  );
  if (!corruptOnly)
    tableEntries[0][1] = Buffer.concat([
      varint(1),
      Buffer.from([0xff, 0x11, 0x01]),
      varint(blobValue.length),
      varint(0),
    ]);
  const blobEntry = [
    recordKey("c-blob", 3),
    Buffer.concat([
      Buffer.from([0]),
      varint(blobNumber),
      varint(4),
      utf16be("text"),
      varint(blobValue.length),
    ]),
  ];
  // Keys in a table are sorted; the tests only need each block well formed.
  const sorted = [
    ...tableEntries,
    ...(corruptOnly ? [] : [blobEntry]),
    storeName("trees"),
  ]
    .map(([key, value], i) => [internal(key, 10 + i), value])
    .sort(([a], [b]) => Buffer.compare(a, b));
  await writeFile(path.join(leveldb, "000005.ldb"), tableFile(sorted));

  const edit = Buffer.concat([
    varint(2),
    varint(7), // log number
    varint(7),
    varint(0),
    varint(5),
    varint(1),
    withLength(Buffer.from("a")),
    withLength(Buffer.from("z")),
  ]);
  await writeFile(path.join(leveldb, "MANIFEST-000002"), logFile([edit]));
  await writeFile(path.join(leveldb, "CURRENT"), "MANIFEST-000002\n");
  // The log, newer than the table: one delete, one overwrite, one new record, and an older log
  // the MANIFEST no longer names, which must be ignored.
  await writeFile(
    path.join(leveldb, "000007.log"),
    logFile(
      corruptOnly
        ? []
        : [
            batch(100, [
              [recordKey("c-deleted"), null],
              [
                recordKey("c-old"),
                plain(
                  conversation(
                    "c-old",
                    [
                      ["human", "second version"],
                      ["assistant", "ok"],
                    ],
                    "2026-01-03T00:00:00.000Z",
                  ),
                ),
              ],
            ]),
            batch(102, [
              [
                recordKey("c-log"),
                plain(conversation("c-log", [["human", "from the log"]])),
              ],
            ]),
          ],
    ),
  );
  await writeFile(
    path.join(leveldb, "000003.log"),
    logFile([
      batch(1, [
        [
          recordKey("c-stale"),
          plain(conversation("c-stale", [["human", "stale"]])),
        ],
      ]),
    ]),
  );
  await writeFile(path.join(leveldb, "LOCK"), "");
  return root;
}

test("snappy decodes literals and back-references, and rejects a bad copy", () => {
  // "abcabcabc": literal "abc", then copy length 6 offset 3 (type 1: len-4 in bits 2-4).
  const encoded = Buffer.from([
    9,
    (3 - 1) << 2,
    0x61,
    0x62,
    0x63,
    1 | ((6 - 4) << 2),
    3,
  ]);
  assert.equal(unsnappy(encoded).toString(), "abcabcabc");
  assert.throws(() => unsnappy(Buffer.from([3, 1 | (0 << 2), 9])), /snappy/);
});

test("reads Desktop conversations from a LevelDB table, log and blob file", async () => {
  const root = await fakeStore();
  const read = await readDesktopChats(root);
  assert.equal(read.status, "ok");
  assert.equal(read.skipped, 0);
  const byUuid = Object.fromEntries(read.conversations.map((c) => [c.uuid, c]));
  assert.deepEqual(Object.keys(byUuid).sort(), [
    "c-blob",
    "c-log",
    "c-old",
    "c-table",
  ]);
  assert.deepEqual(
    byUuid["c-blob"].messages.map((m) => [m.sender, m.text]),
    [
      ["human", "stored in a blob"],
      ["assistant", "ok"],
      ["human", "more"],
    ],
  );
  assert.equal(byUuid["c-table"].messages[0].text, "hello table");
  // The log's newer write wins over the table's.
  assert.equal(byUuid["c-old"].messageCount, 2);
  assert.equal(byUuid["c-old"].messages[0].text, "second version");
  assert.equal(byUuid["c-old"].updatedAt, "2026-01-03T00:00:00.000Z");
  // Newest first.
  assert.equal(read.conversations[0].uuid, "c-old");
});

test("a store with no readable conversation is DESKTOP_CHAT_UNREADABLE; no store is absent", async () => {
  const root = await fakeStore({ corruptOnly: true });
  await assert.rejects(readDesktopChats(root), (error) => {
    assert.ok(error instanceof DesktopChatUnreadable);
    assert.equal(error.code, "DESKTOP_CHAT_UNREADABLE");
    return true;
  });
  const empty = await mkdtemp(path.join(os.tmpdir(), "ocean-desktop-none-"));
  assert.deepEqual(await readDesktopChats(empty), { status: "absent" });
});

test("an edited message keeps only the branch that ends at the newest leaf", () => {
  const record = conversation("c-branch", [
    ["human", "q"],
    ["assistant", "a1"],
  ]);
  // A retry: a sibling of a1, created later, with a follow-up.
  record.tree.messages.push(
    {
      uuid: "retry",
      sender: "assistant",
      index: 1,
      parent_message_uuid: "c-branch-m0",
      content: [{ type: "text", text: "a2" }],
      created_at: "2026-01-01T00:00:05.000Z",
    },
    {
      uuid: "follow",
      sender: "human",
      index: 2,
      parent_message_uuid: "retry",
      content: [{ type: "text", text: "thanks" }],
      created_at: "2026-01-01T00:00:06.000Z",
    },
  );
  const parsed = conversationFromRecord(record);
  assert.deepEqual(
    parsed.messages.map((m) => m.text),
    ["q", "a2", "thanks"],
  );
  assert.equal(conversationFromRecord({ conversationUuid: "x" }), null);
});

test("a message keeps its tool calls and results as bracketed lines, cut short; thinking is left out (T-329)", () => {
  const long = "x".repeat(TOOL_RESULT_CHARS + 50);
  const text = messageText([
    { type: "thinking", thinking: "private reasoning" },
    { type: "text", text: "Let me look." },
    {
      type: "tool_use",
      name: "mcp__remote-devices__ocean__brain_search",
      input: { summary: "recent projects" },
    },
    {
      type: "tool_result",
      name: "brain_search",
      is_error: false,
      content: [{ type: "text", text: `found\n  ${long}` }],
    },
    { type: "tool_use", name: "ocean_status", input: {} },
    {
      type: "tool_result",
      is_error: true,
      content: [{ type: "text", text: "boom" }],
    },
    { type: "text", text: "Done." },
  ]);
  const lines = text.split("\n\n");
  assert.equal(lines[0], "Let me look.");
  assert.equal(lines[1], "[tool brain_search: recent projects]");
  assert.match(lines[2], /^\[tool result: found x+…\]$/);
  assert.ok(lines[2].length < TOOL_RESULT_CHARS + 30);
  assert.equal(lines[3], "[tool ocean_status]");
  assert.equal(lines[4], "[tool error: boom]");
  assert.equal(lines[5], "Done.");
  assert.doesNotMatch(text, /private reasoning/);
});
