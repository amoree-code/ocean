import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { splitMarkdown } from "@ocean/brain/memory/memory-harvest.js";
import {
  approveCandidate,
  listCandidates,
} from "@ocean/brain/memory/memory-review.js";
import {
  readMemoryRecord,
  writeMemoryRecord,
} from "@ocean/brain/memory/memory-write.js";
import {
  listProjectManifests,
  projectFormerPaths,
  projectTags,
  writeManifest,
} from "@ocean/core/shared/project-resolution.js";
import {
  buildHistoryIndex,
  historyIndexFile,
  searchHistory,
  serverHistoryDir,
} from "../dist/application/pull/history-index.js";
import { lastPullRecord, pull } from "../dist/application/pull/pull.js";

// T-305: `ocean pull` on a synthetic home and workspace — every client's memory and hand-written
// instructions as candidates, a claude.ai export from ~/Downloads, and an index of every
// conversation, all sorted by the owner's projects, each item saying where it came from.
const jsonl = (...lines) =>
  `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
const TOKEN = `ghp_${"k".repeat(36)}`;
const group = (title) =>
  `# ${title}\n\n${`Learned fact about ${title}. `.repeat(600)}\n`;

// Windows resolves `/work/app` to `D:\work\app` and shows home paths with `\`; Claude Code
// names a project's folder after its full path either way.
const abs = (folder) => path.resolve(folder);
const shown = (file) => path.join("~", file);
const claudeSlug = (folder) => abs(folder).replace(/[^A-Za-z0-9]/g, "-");

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "ocean-pull-"));
  const home = path.join(base, "home");
  const root = path.join(base, "ocean");
  const put = async (file, text, at = home) => {
    await mkdir(path.dirname(path.join(at, file)), { recursive: true });
    await writeFile(path.join(at, file), text);
  };
  // The owner's projects: one bound to a folder (with a folder it lived in before), one known
  // only by name.
  await put(
    "04-projects/app/project.json",
    JSON.stringify({
      id: "app",
      name: "app",
      paths: ["/work/app"],
      formerPaths: ["/old/api-server"],
      tags: ["company"],
    }),
    root,
  );
  await put(
    "04-projects/letspeak/project.json",
    JSON.stringify({
      id: "letspeak",
      name: "letspeak",
      paths: [],
      tags: ["personal"],
    }),
    root,
  );
  // Codex: one oversized MEMORY.md (one group names a project), its raw duplicate, summaries.
  await put(
    ".codex/memories/MEMORY.md",
    [
      group("Task Group: app login"),
      group("Task Group: habits"),
      group("Task Group: tooling"),
    ].join("\n"),
  );
  await put(".codex/memories/raw_memories.md", "## raw\n\nsame as summaries\n");
  await put(
    ".codex/memories/rollout_summaries/2026-08-29T09-28-07-1L05-fix_login_flow.md",
    "# summary\n",
  );
  // Gemini holds the same fact as Codex's notes, spaced and cased differently.
  await put(".codex/memories/notes.md", "Prefers pnpm over npm.\n");
  await put(".gemini/memory/dup.md", "PREFERS   pnpm over NPM.\n");
  // Claude Code's memory for the app folder.
  await put(
    `.claude/projects/${claudeSlug("/work/app")}/memory/stack.md`,
    "# Stack\n\nNext.js 15.\n",
  );
  // Instructions: Ocean's generated block and includes are not imported; the owner's text is.
  await put(
    ".codex/AGENTS.md",
    "<!-- ai-sync:generated -->\nOcean charter copy\n<!-- ai-sync:end -->\n\nAlways answer in Arabic.\n",
  );
  await put(".claude/CLAUDE.md", "@~/ocean/charter/core.md\n");
  // Conversations, one per client format.
  await put(
    `.claude/projects/${claudeSlug("/work/app")}/s1.jsonl`,
    jsonl(
      {
        type: "user",
        cwd: "/work/app/web",
        message: { content: "<command-name>/clear" },
      },
      {
        type: "user",
        cwd: "/work/app/web",
        message: { content: `Fix the login flow with ${TOKEN}` },
      },
    ),
  );
  await put(
    ".codex/sessions/2026/10/31/rollout-1.jsonl",
    jsonl(
      {
        type: "session_meta",
        payload: { id: "c1", cwd: "/old/api-server/src" },
      },
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
  await put(".gemini/tmp/h1/.project_root", "/elsewhere/letspeak\n");
  await put(
    ".gemini/tmp/h1/chats/session-1.jsonl",
    jsonl(
      { sessionId: "g1", lastUpdated: "2026-10-02T00:00:00Z" },
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
  // Claude Desktop ran s1 through Claude Code: the same conversation.
  await put(
    "Library/Application Support/Claude/claude-code-sessions/x/y/local_1.json",
    JSON.stringify({
      sessionId: "d1",
      cliSessionId: "s1",
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

test("pull: a dry run sorts every source by project and writes nothing", async () => {
  const { home, root } = await fixture();
  await withRoot(root, async () => {
    const dry = await pull({ home });
    assert.equal(dry.applied, false);
    // MEMORY.md's three groups + notes.md; raw_memories.md is history, not memory.
    assert.deepEqual(dry.memory.codex, { new: 4 });
    // The same fact in Gemini, other spacing and case: one candidate, not two.
    assert.deepEqual(dry.memory.gemini, { seen: 1 });
    assert.deepEqual(dry.memory.instructions, { new: 1 });
    assert.deepEqual(dry.history, {
      "claude-code": 1,
      codex: 1,
      "codex-summary": 1,
      gemini: 1,
      cursor: 1,
    });
    assert.deepEqual(dry.projects.app, {
      memory: { new: 2 },
      history: { "claude-code": 1, codex: 1 },
    });
    assert.deepEqual(dry.projects.letspeak, {
      memory: { new: 2 },
      history: { gemini: 1 },
    });
    assert.deepEqual(dry.unassignedFolders, [
      { folder: abs("/work/ui"), conversations: 1 },
    ]);
    assert.equal(dry.exports[0].items, 2);
    assert.deepEqual(dry.exports[0].unread, ["conversations.json"]);
    await assert.rejects(readdir(path.join(root, "00-inbox", "candidates")));
    await assert.rejects(readFile(historyIndexFile()));
    assert.equal(await lastPullRecord(), null);
  });
});

test("pull --yes: candidates say where they came from, the index is sorted and searchable, once a day", async () => {
  const { home, root } = await fixture();
  await withRoot(root, async () => {
    const applied = await pull({ home, apply: true });
    assert.equal(applied.memory.codex.proposed, 4);
    assert.equal(applied.exports[0].new, 2);

    const candidates = await listCandidates();
    assert.equal(candidates.length, 8);
    const stack = candidates.find((item) =>
      item.content.includes("Next.js 15"),
    );
    assert.equal(stack.meta.client, "claude-code");
    assert.equal(stack.meta.project, "app");
    assert.deepEqual(stack.meta.tags, ["company"]);
    assert.equal(stack.meta.pull, true);
    assert.equal(stack.meta.title, "Stack");
    assert.equal(
      stack.meta.file,
      shown(`.claude/projects/${claudeSlug("/work/app")}/memory/stack.md`),
    );
    assert.match(stack.meta.date, /^\d{4}-\d\d-\d\d$/);
    assert.match(
      stack.target,
      /^04-projects\/app\/memory\/stack-[0-9a-f]{6}\.md$/,
    );
    const login = candidates.find(
      (item) => item.meta.title === "Task Group: app login",
    );
    assert.equal(login.meta.project, "app");
    assert.equal(login.meta.file, `${shown(".codex/memories/MEMORY.md")}#1`);
    const habits = candidates.find(
      (item) => item.meta.title === "Task Group: habits",
    );
    assert.equal(habits.meta.project, "personal");
    assert.equal(habits.target, "");
    const plan = candidates.find((item) =>
      item.content.includes("Ship the beta"),
    );
    assert.equal(plan.meta.client, "claude.ai");
    assert.equal(plan.meta.project, "letspeak");
    assert.ok(
      candidates.some((item) =>
        item.content.includes("Always answer in Arabic."),
      ),
    );
    assert.ok(
      !candidates.some((item) => item.content.includes("Ocean charter copy")),
    );

    const [hit] = await searchHistory("login flow");
    assert.equal(hit.client, "claude-code");
    assert.equal(hit.project, "app");
    assert.deepEqual(hit.tags, ["company"]);
    assert.equal(hit.cwd, abs("/work/app/web"));
    assert.equal(hit.pull, true);
    assert.deepEqual(hit.alsoIn, ["claude-desktop"]);
    assert.match(hit.title, /^Fix the login flow/);
    assert.ok(!(await readFile(historyIndexFile(), "utf8")).includes(TOKEN));
    assert.equal((await searchHistory("rate limiting"))[0].project, "app");
    assert.deepEqual(
      (await searchHistory("", { project: "app" }))
        .map((entry) => entry.client)
        .sort(),
      ["claude-code", "codex"],
    );
    assert.equal((await searchHistory("company")).length, 2);

    // Every item read is in the run's record, with what became of it.
    const record = await lastPullRecord();
    assert.equal(record.items.length, 9);
    assert.ok(record.items.every((item) => item.status && item.project));

    assert.match(
      (await pull({ home, apply: true, daily: true })).skipped,
      /^last pull /,
    );
    const again = await pull({ home, apply: true });
    assert.deepEqual(again.memory.codex, { seen: 4 });
    assert.equal(again.exports[0].new, 0);
    assert.equal((await listCandidates()).length, 8);
  });
});

test("pull --yes with pullAutoApprove on: new records are written, the rest waits for review", async () => {
  const { home, root } = await fixture();
  await withRoot(root, async () => {
    await mkdir(path.join(root, "bridge", "config"), { recursive: true });
    await writeFile(
      path.join(root, "bridge", "config", "memory.json"),
      JSON.stringify({ pullAutoApprove: "on" }),
    );
    const result = await pull({ home, apply: true });
    const record = await lastPullRecord();
    const proposed = record.items.filter((item) => item.candidate);
    assert.equal(
      result.autoApproved.approved + result.autoApproved.review,
      proposed.length,
    );
    const approved = proposed.filter((item) => item.approved);
    assert.equal(approved.length, result.autoApproved.approved);
    assert.ok(approved.length > 0);
    for (const item of approved)
      assert.ok((await readMemoryRecord(item.approved)).content);
    // Left for review: no target to write to, and nothing else.
    const left = await listCandidates();
    assert.equal(left.length, result.autoApproved.review);
    assert.ok(left.every((item) => item.target === ""));
    assert.ok(
      proposed
        .filter((item) => item.review)
        .every((item) => /target/.test(item.review)),
    );
  });
});

test("pull --yes leaves memory for review by default; an unreviewed approval never adds to a record", async () => {
  const { home, root } = await fixture();
  await withRoot(root, async () => {
    const result = await pull({ home, apply: true });
    assert.equal(result.autoApproved, undefined);
    const stack = (await listCandidates()).find((item) =>
      item.content.includes("Next.js 15"),
    );
    await writeMemoryRecord({
      path: stack.target,
      content: "# Stack\n\nWritten by the owner.\n",
      mode: "create",
      source: "test",
    });
    await assert.rejects(
      approveCandidate({ id: stack.id, createOnly: true }),
      (error) => error.code === "CONFLICT",
    );
    assert.ok((await listCandidates()).some((item) => item.id === stack.id));
    assert.equal(
      (await readMemoryRecord(stack.target)).content,
      "# Stack\n\nWritten by the owner.\n",
    );
  });
});

test("splitMarkdown cuts at headings, then paragraphs, and never inside one", () => {
  const text = [group("one"), group("two"), group("three")].join("\n");
  const parts = splitMarkdown(text, 20_000);
  assert.equal(parts.length, 3);
  assert.equal(parts.join(""), text);
  assert.ok(parts.every((part) => part.startsWith("# ")));
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
      entries.map(({ client, id, cwd, title }) => ({ client, id, cwd, title })),
      [
        {
          client: "codex",
          id: "z1",
          cwd: abs("/work/old"),
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

test("project manifests keep tags and former folders through a rewrite", async () => {
  const { root } = await fixture();
  await withRoot(root, async () => {
    const app = (await listProjectManifests()).find(
      (item) => item.id === "app",
    );
    await writeManifest({ ...app, paths: [...app.paths, "/work/app2"] });
    const again = (await listProjectManifests()).find(
      (item) => item.id === "app",
    );
    assert.deepEqual(projectTags(again), ["company"]);
    assert.deepEqual(projectFormerPaths(again), ["/old/api-server"]);
  });
});

test("placement: the longest project name in a heading wins; generic current folder names are not names", async () => {
  const { placeFolder, placeMemory } = await import(
    "../dist/application/pull/project-match.js"
  );
  const index = {
    home: abs("/h"),
    projects: [
      {
        id: "ocean",
        names: ["ocean", "atlas"],
        tags: [],
        folders: [abs("/h/ocean")],
      },
      {
        id: "ocean-ielts",
        names: ["ocean-ielts"],
        tags: ["personal"],
        folders: [abs("/h/ielts/dashboard")],
      },
    ],
  };
  const heading = (text) =>
    placeMemory(index, { client: "codex", file: "/m.md", text }).project;
  assert.equal(heading("# Ocean IELTS writing plan\n"), "ocean-ielts");
  assert.equal(heading("# Ocean engine\n"), "ocean");
  assert.equal(heading("# Atlas engine notes\n"), "ocean");
  assert.equal(heading("# Groceries\n"), "personal");
  assert.equal(placeFolder(index, "/h/atlas/engine").project, "ocean");
  assert.equal(
    placeFolder(index, "/elsewhere/dashboard").project,
    "unassigned",
  );
  assert.equal(placeFolder(index, "/h").project, "scratch");
  assert.equal(placeFolder(index, "/tmp/x").project, "scratch");
});

test("placement: folder names match without regard to case, as on macOS", async () => {
  const { placeFolder } = await import(
    "../dist/application/pull/project-match.js"
  );
  const index = {
    home: abs("/h"),
    projects: [
      {
        id: "mcp",
        names: ["mcp"],
        tags: [],
        folders: [abs("/h/ocean-UIUX-MCP")],
      },
    ],
  };
  assert.equal(placeFolder(index, "/h/Ocean-UIUX-MCP/src").project, "mcp");
});

test("pull --yes: two runs at once propose each item once", async () => {
  const { home, root } = await fixture();
  await withRoot(root, async () => {
    const [first, second] = await Promise.all([
      pull({ home, apply: true, daily: true }),
      pull({ home, apply: true, daily: true }),
    ]);
    assert.equal([first, second].filter((run) => run.skipped).length, 1);
    assert.equal((await listCandidates()).length, 8);
  });
});

test("history: Antigravity's conversations come from its summaries database", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const base = await mkdtemp(path.join(os.tmpdir(), "ocean-pull-agy-"));
  const home = path.join(base, "home");
  const folder = path.join(home, ".gemini/antigravity");
  await mkdir(path.join(folder, "conversations"), { recursive: true });
  await writeFile(path.join(folder, "conversations/a1.pb"), "binary");
  const db = new DatabaseSync(path.join(folder, "conversation_summaries.db"));
  db.exec(
    "create table conversation_summaries (conversation_id text, title text, preview text, last_modified_time datetime, workspace_uris text)",
  );
  db.prepare("insert into conversation_summaries values (?, ?, ?, ?, ?)").run(
    "a1",
    "",
    "Refactor the parser",
    "2026-09-16 18:43:39.327565+00:00",
    JSON.stringify([pathToFileURL(abs("/work/app")).href]),
  );
  db.prepare("insert into conversation_summaries values (?, ?, ?, ?, ?)").run(
    "a2",
    "Named one",
    "ignored preview",
    "2026-09-17 10:00:00+00:00",
    "",
  );
  db.close();
  await withRoot(path.join(base, "ocean"), async () => {
    const entries = (await buildHistoryIndex({ home })).map(
      ({ client, id, cwd, title, file, date }) => ({
        client,
        id,
        cwd,
        title,
        file,
        date,
      }),
    );
    assert.deepEqual(entries, [
      {
        client: "antigravity",
        id: "a2",
        cwd: undefined,
        title: "Named one",
        file: `${shown(".gemini/antigravity/conversation_summaries.db")}#a2`,
        date: "2026-09-17",
      },
      {
        client: "antigravity",
        id: "a1",
        cwd: abs("/work/app"),
        title: "Refactor the parser",
        file: shown(".gemini/antigravity/conversations/a1.pb"),
        date: "2026-09-16",
      },
    ]);
  });
});

test("history: server-side conversations come from snapshots, with their link and project", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "ocean-pull-server-"));
  const home = path.join(base, "home");
  await mkdir(home, { recursive: true });
  await withRoot(path.join(base, "ocean"), async () => {
    await mkdir(serverHistoryDir(), { recursive: true });
    await writeFile(
      path.join(serverHistoryDir(), "claude-ai.jsonl"),
      jsonl(
        {
          id: "c1",
          title: `IELTS speaking ${TOKEN}`,
          url: "https://claude.ai/chat/c1",
          updated: "2026-09-20T08:00:00Z",
          project: "ocean-ielts",
          tags: ["letspeak"],
        },
        { id: "c2", title: "No link" },
        "not json",
      ),
    );
    const entries = (await buildHistoryIndex({ home, write: true })).map(
      ({ client, id, project, tags, title, file, date }) => ({
        client,
        id,
        project,
        tags,
        title,
        file,
        date,
      }),
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].title.includes(TOKEN), false);
    assert.deepEqual(
      { ...entries[0], title: undefined },
      {
        client: "claude-ai",
        id: "c1",
        project: "ocean-ielts",
        tags: ["letspeak"],
        title: undefined,
        file: "https://claude.ai/chat/c1",
        date: "2026-09-20",
      },
    );
    assert.equal((await searchHistory("ielts letspeak")).length, 1);
  });
});

// A Chromium "simple cache" entry file: header, key (the URL), body, end record, response
// headers, end record — the layout Claude Desktop and Chrome write.
function cacheEntry(url, value, encoding) {
  const key = Buffer.from(`1/0/_dk_https://site https://site ${url}`, "latin1");
  const header = Buffer.alloc(24);
  header.writeBigUInt64LE(0xfcfb6d1ba7725c30n, 0);
  header.writeUInt32LE(5, 8);
  header.writeUInt32LE(key.length, 12);
  const raw = Buffer.from(JSON.stringify(value));
  const body =
    encoding === "br"
      ? zlib.brotliCompressSync(raw)
      : encoding === "gzip"
        ? zlib.gzipSync(raw)
        : raw;
  const end = Buffer.concat([
    Buffer.from("d8410d97456ffaf4", "hex"),
    Buffer.alloc(12),
  ]);
  const headers = Buffer.from(
    `HTTP/1.1 200\0content-type: application/json\0${encoding ? `content-encoding: ${encoding}\0` : ""}date: Sat, 01 Nov 2026 10:00:00 GMT\0`,
    "latin1",
  );
  return Buffer.concat([header, key, body, end, headers, end]);
}

test("pull --yes: claude.ai and ChatGPT come from Desktop's and the browsers' caches", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "ocean-pull-cache-"));
  const home = path.join(base, "home");
  const root = path.join(base, "ocean");
  const org = "11111111-2222-4333-8444-555555555555";
  const project = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const [inProject, loose, hidden] = [
    "c1c1c1c1-0000-4000-8000-000000000001",
    "c2c2c2c2-0000-4000-8000-000000000002",
    "c9c9c9c9-0000-4000-8000-000000000009",
  ];
  const put = async (dir, name, buffer) => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), buffer);
  };
  const desktop = path.join(
    home,
    "Library/Application Support/Claude/Cache/Cache_Data",
  );
  const api = `https://claude.ai/api/organizations/${org}`;
  await put(
    desktop,
    "a_0",
    cacheEntry(
      `${api}/projects?limit=30`,
      [{ uuid: project, name: "Letspeak" }],
      "gzip",
    ),
  );
  await put(
    desktop,
    "b_0",
    cacheEntry(
      `${api}/chat_conversations_v2?limit=30`,
      {
        data: [
          {
            uuid: inProject,
            name: "IELTS speaking",
            updated_at: "2026-10-29T08:00:00Z",
            project_uuid: project,
          },
          {
            uuid: loose,
            name: "Renamed chat",
            updated_at: "2026-10-30T08:00:00Z",
          },
        ],
      },
      "br",
    ),
  );
  await put(
    desktop,
    "c_0",
    cacheEntry(`${api}/memory`, {
      memory: "Ameer is preparing for IELTS.",
      updated_at: "2026-09-01T00:00:00Z",
    }),
  );
  // A URL naming a token is never opened, whatever it holds.
  await put(
    desktop,
    "d_0",
    cacheEntry(`${api}/chat_conversations?oauth_token=1`, [
      { uuid: hidden, name: "never read" },
    ]),
  );
  await put(desktop, "e_1", Buffer.from("not an entry"));
  const chrome = path.join(
    home,
    "Library/Caches/Google/Chrome/Profile 1/Cache/Cache_Data",
  );
  await put(
    chrome,
    "f_0",
    cacheEntry("https://chatgpt.com/backend-api/conversations?offset=0", {
      items: [{ id: "g-1", title: "Budget table", update_time: 1790000000.5 }],
    }),
  );
  await put(
    chrome,
    "g_0",
    cacheEntry("https://chatgpt.com/backend-api/memories?include=1", {
      memories: [{ content: "Uses Notion for budgets." }],
    }),
  );
  await withRoot(root, async () => {
    await mkdir(path.join(root, "04-projects/letspeak"), { recursive: true });
    await writeFile(
      path.join(root, "04-projects/letspeak/project.json"),
      JSON.stringify({ id: "letspeak", name: "letspeak", paths: [] }),
    );
    // Placed by hand earlier: kept; the newer title still replaces the old one.
    await mkdir(serverHistoryDir(), { recursive: true });
    await writeFile(
      path.join(serverHistoryDir(), "claude-ai.jsonl"),
      jsonl({
        id: loose,
        title: "Old title",
        url: `https://claude.ai/chat/${loose}`,
        updated: "2026-10-01T00:00:00Z",
        project: "personal",
        tags: ["claude.ai"],
      }),
    );

    const first = await pull({ home, apply: true });
    assert.deepEqual(first.server, {
      "claude-ai": { conversations: 2, new: 1 },
      chatgpt: { conversations: 1, new: 1 },
    });
    const claude = (
      await readFile(path.join(serverHistoryDir(), "claude-ai.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      claude.map(({ id, title, project, tags }) => ({
        id,
        title,
        project,
        tags,
      })),
      [
        {
          id: loose,
          title: "Renamed chat",
          project: "personal",
          tags: ["claude.ai"],
        },
        {
          id: inProject,
          title: "IELTS speaking",
          project: "letspeak",
          tags: ["claude.ai", "Letspeak"],
        },
      ],
    );
    assert.equal(
      (await searchHistory("budget table"))[0]?.file,
      "https://chatgpt.com/c/g-1",
    );
    assert.equal((await searchHistory("never read")).length, 0);
    const texts = (await listCandidates()).map((item) => item.content);
    assert.ok(
      texts.some((text) => text.includes("Ameer is preparing for IELTS.")),
    );
    assert.ok(
      texts.some((text) => text.includes("- Uses Notion for budgets.")),
    );

    // Nothing is proposed or added twice.
    const second = await pull({ home, apply: true });
    assert.deepEqual(second.server, {
      "claude-ai": { conversations: 2, new: 0 },
      chatgpt: { conversations: 1, new: 0 },
    });
    assert.equal((await listCandidates()).length, texts.length);
  });
});
