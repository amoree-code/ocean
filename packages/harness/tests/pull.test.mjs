import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { splitMarkdown } from "@ocean/brain/memory/memory-harvest.js";
import { listCandidates } from "@ocean/brain/memory/memory-review.js";
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
    ".claude/projects/-work-app/memory/stack.md",
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
    ".claude/projects/-work-app/s1.jsonl",
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
      { folder: "/work/ui", conversations: 1 },
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
      "~/.claude/projects/-work-app/memory/stack.md",
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
    assert.equal(login.meta.file, "~/.codex/memories/MEMORY.md#1");
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
    assert.equal(hit.cwd, "/work/app/web");
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
          cwd: "/work/old",
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
    home: "/h",
    projects: [
      {
        id: "ocean",
        names: ["ocean", "atlas"],
        tags: [],
        folders: ["/h/ocean"],
      },
      {
        id: "ocean-ielts",
        names: ["ocean-ielts"],
        tags: ["personal"],
        folders: ["/h/ielts/dashboard"],
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
    home: "/h",
    projects: [
      { id: "mcp", names: ["mcp"], tags: [], folders: ["/h/ocean-UIUX-MCP"] },
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
