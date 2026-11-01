import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { splitMarkdown } from "@ocean/brain/memory/memory-harvest.js";
import {
  buildHistoryIndex,
  historyIndexFile,
  searchHistory,
} from "../dist/application/pull/history-index.js";
import { pull } from "../dist/application/pull/pull.js";

// T-305: `ocean pull` on a synthetic home — every client's memory and hand-written instructions
// as candidates, a claude.ai export from ~/Downloads, and an index of every conversation.
const jsonl = (...lines) =>
  `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
const TOKEN = `ghp_${"k".repeat(36)}`;
const group = (n) =>
  `# Task Group ${n}\n\n${`Learned fact ${n}. `.repeat(900)}\n`;

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "ocean-pull-"));
  const home = path.join(base, "home");
  const root = path.join(base, "ocean");
  await mkdir(root, { recursive: true });
  const put = async (file, text) => {
    await mkdir(path.dirname(path.join(home, file)), { recursive: true });
    await writeFile(path.join(home, file), text);
  };
  // Codex: one oversized MEMORY.md, its raw duplicate, and per-session summaries.
  await put(".codex/memories/MEMORY.md", [1, 2, 3].map(group).join("\n"));
  await put(".codex/memories/raw_memories.md", "## raw\n\nsame as summaries\n");
  await put(
    ".codex/memories/rollout_summaries/2026-08-29T09-28-07-1L05-fix_login_flow.md",
    "# summary\n",
  );
  // Instructions: Ocean's generated block and includes are not imported; the owner's text is.
  await put(
    ".codex/AGENTS.md",
    "<!-- ai-sync:generated -->\nOcean charter copy\n<!-- ai-sync:end -->\n\nAlways answer in Arabic.\n",
  );
  await put(".claude/CLAUDE.md", "@~/ocean/charter/core.md\n");
  // Conversations, one per client format.
  await put(
    ".claude/projects/-work-app/s1.jsonl",
    jsonl(
      {
        type: "user",
        cwd: "/work/app",
        message: { content: "<command-name>/clear" },
      },
      {
        type: "user",
        cwd: "/work/app",
        message: { content: `Fix the login flow with ${TOKEN}` },
      },
    ),
  );
  await put(
    ".codex/sessions/2026/10/31/rollout-1.jsonl",
    jsonl(
      { type: "session_meta", payload: { id: "c1", cwd: "/work/api" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ text: "<environment_context>x" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ text: "Add rate limiting" }],
        },
      },
    ),
  );
  await put(".gemini/tmp/h1/.project_root", "/work/site\n");
  await put(
    ".gemini/tmp/h1/chats/session-1.jsonl",
    jsonl(
      {
        sessionId: "g1",
        startTime: "2026-10-01T00:00:00Z",
        lastUpdated: "2026-10-02T00:00:00Z",
      },
      { type: "user", content: [{ text: "Plan the release" }] },
    ),
  );
  await put(
    ".cursor/chats/a/b/meta.json",
    JSON.stringify({
      title: "Style the navbar",
      cwd: "/work/ui",
      updatedAtMs: 1_790_000_000_000,
    }),
  );
  await put(
    "Library/Application Support/Claude/claude-code-sessions/x/y/local_1.json",
    JSON.stringify({
      sessionId: "d1",
      title: "Desktop review",
      cwd: "/work/app",
      lastActivityAt: 1_790_000_000_000,
    }),
  );
  // A claude.ai export, unpacked in ~/Downloads.
  await put(
    "Downloads/data-2026-11-01/projects.json",
    JSON.stringify([
      {
        name: "letspeak",
        description: "Speaking practice app",
        prompt_template: "Be brief",
        docs: [{ filename: "plan.md", content: "Ship the beta" }],
      },
    ]),
  );
  await put("Downloads/data-2026-11-01/conversations.json", "[]");
  return { home, root };
}

async function withRoot(root, run) {
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

test("pull: a dry run counts every source and writes nothing", async () => {
  const { home, root } = await fixture();
  await withRoot(root, async () => {
    const dry = await pull({ home });
    assert.equal(dry.applied, false);
    // MEMORY.md is split into its three task groups; raw_memories.md is history, not memory.
    assert.equal(dry.memory.codex.new, 3);
    assert.equal(dry.memory.instructions.new, 1);
    assert.deepEqual(dry.history, {
      "claude-code": 1,
      codex: 1,
      "codex-summary": 1,
      gemini: 1,
      cursor: 1,
      "claude-desktop": 1,
    });
    assert.equal(dry.exports.length, 1);
    assert.equal(dry.exports[0].items, 2);
    assert.deepEqual(dry.exports[0].unread, ["conversations.json"]);
    await assert.rejects(readdir(path.join(root, "00-inbox", "candidates")));
    await assert.rejects(readFile(historyIndexFile()));
  });
});

test("pull --yes: candidates, a searchable index with redacted titles, then once a day", async () => {
  const { home, root } = await fixture();
  await withRoot(root, async () => {
    const applied = await pull({ home, apply: true });
    assert.equal(applied.memory.codex.proposed, 3);
    assert.equal(applied.memory.instructions.proposed, 1);
    assert.equal(applied.exports[0].new, 2);
    const days = await readdir(path.join(root, "00-inbox", "candidates"));
    const candidates = await readdir(
      path.join(root, "00-inbox", "candidates", days[0]),
    );
    assert.equal(candidates.length, 6);
    const texts = await Promise.all(
      candidates.map((name) =>
        readFile(
          path.join(root, "00-inbox", "candidates", days[0], name),
          "utf8",
        ),
      ),
    );
    assert.ok(texts.some((text) => text.includes("Always answer in Arabic.")));
    assert.ok(!texts.some((text) => text.includes("Ocean charter copy")));

    const [hit] = await searchHistory("login flow");
    assert.equal(hit.client, "claude-code");
    assert.equal(hit.project, "/work/app");
    assert.match(hit.title, /^Fix the login flow/);
    assert.ok(!(await readFile(historyIndexFile(), "utf8")).includes(TOKEN));
    assert.equal(
      (await searchHistory("rate limiting", { client: "codex" }))[0].project,
      "/work/api",
    );
    assert.equal((await searchHistory("release"))[0].project, "/work/site");
    assert.equal((await searchHistory("work app")).length, 2);

    assert.match(
      (await pull({ home, apply: true, daily: true })).skipped,
      /^last pull /,
    );
    const again = await pull({ home, apply: true });
    assert.equal(again.memory.codex.seen, 3);
    assert.equal(again.memory.codex.proposed, undefined);
    assert.equal(again.exports[0].new, 0);
  });
});

test("splitMarkdown cuts at headings, then paragraphs, and never inside one", () => {
  const text = [1, 2, 3].map(group).join("\n");
  const parts = splitMarkdown(text, 20_000);
  assert.equal(parts.length, 3);
  assert.equal(parts.join(""), text);
  assert.ok(parts.every((part) => part.startsWith("# Task Group")));
  const paragraphs = `${"a".repeat(15_000)}\n\n${"b".repeat(15_000)}\n`;
  assert.deepEqual(splitMarkdown(paragraphs, 20_000), [
    `${"a".repeat(15_000)}\n\n`,
    `${"b".repeat(15_000)}\n`,
  ]);
  const blob = "x".repeat(30_000);
  assert.deepEqual(splitMarkdown(blob, 20_000), [blob]);
});

test("history: Codex's zstd-compressed sessions are indexed with their title", {
  skip: typeof zlib.zstdCompressSync !== "function" && "no zstd in this Node",
}, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "ocean-pull-zst-"));
  const home = path.join(base, "home");
  const file = path.join(
    home,
    ".codex/sessions/2026/09/01/rollout-old.jsonl.zst",
  );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    zlib.zstdCompressSync(
      jsonl(
        { type: "session_meta", payload: { id: "z1", cwd: "/work/old" } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ text: "Migrate the database" }],
          },
        },
      ),
    ),
  );
  await withRoot(path.join(base, "ocean"), async () => {
    const entries = await buildHistoryIndex({ home });
    assert.deepEqual(
      entries.map(({ client, id, project, title }) => ({
        client,
        id,
        project,
        title,
      })),
      [
        {
          client: "codex",
          id: "z1",
          project: "/work/old",
          title: "Migrate the database",
        },
      ],
    );
  });
});

test("history titles: injected tags are stripped, a stored title wins, Gemini's batched messages are read", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "ocean-pull-titles-"));
  const home = path.join(base, "home");
  const put = async (file, text) => {
    await mkdir(path.dirname(path.join(home, file)), { recursive: true });
    await writeFile(path.join(home, file), text);
  };
  await put(
    ".claude/projects/-w/ide.jsonl",
    jsonl({
      type: "user",
      cwd: "/w",
      message: {
        content: [
          {
            text: "<ide_opened_file>a.ts</ide_opened_file>\nWhy does the build fail?",
          },
        ],
      },
    }),
  );
  await put(
    ".claude/projects/-w/named.jsonl",
    jsonl(
      { type: "user", cwd: "/w", message: { content: "first question" } },
      { type: "ai-title", aiTitle: "Generated title" },
      { type: "custom-title", customTitle: "My own title" },
    ),
  );
  await put(
    ".gemini/tmp/h/chats/session-2.jsonl",
    jsonl(
      { sessionId: "g2", lastUpdated: "2026-10-03T00:00:00Z" },
      {
        $set: {
          messages: [
            {
              type: "user",
              content: [{ text: "<session_context>\ninjected" }],
            },
          ],
        },
      },
      {
        $set: {
          messages: [
            {
              type: "user",
              content: [{ text: "<session_context>\ninjected" }],
            },
            { type: "user", content: [{ text: "Translate the page" }] },
          ],
        },
      },
    ),
  );
  await withRoot(path.join(base, "ocean"), async () => {
    const titles = Object.fromEntries(
      (await buildHistoryIndex({ home })).map((entry) => [
        entry.id,
        entry.title,
      ]),
    );
    assert.deepEqual(titles, {
      ide: "Why does the build fail?",
      named: "My own title",
      g2: "Translate the page",
    });
  });
});
