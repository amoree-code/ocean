import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clientsRow,
  hygieneRow,
  lessonsRows,
  memoryWritesRow,
  readLessonFrontmatter,
  readTaskFrontmatter,
  renderMarkdown,
  renderTable,
  schedulesRow,
  scorecardRows,
  searchRows,
  sessionsVerifiedRow,
  sessionsWithTaskRow,
  sessionTokens,
  tasksVerifiedRow,
  tokensRow,
  writeScorecard,
} from "@ocean/services/scorecard/scorecard.js";

// T-318: each scorecard row computed from real-shaped data; a row without a source is n/a.

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-scorecard-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

const write = async (root, file, text) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
};

test("clients: only in-app confirmed clients count; unsupported ones are not in the total", () => {
  const row = clientsRow([
    { code: "CLIENT_WIRED" },
    { code: "CLIENT_WIRED" },
    { code: "CLIENT_CHECK_PENDING" },
    { code: "CLIENT_BLOCKED" },
    { code: "CLIENT_NOT_WIRED" },
    { code: "CLIENT_MANUAL" },
    { code: "CLIENT_UNSUPPORTED" },
  ]);
  assert.equal(row.value, "2 of 6");
  assert.deepEqual([row.n, row.of], [2, 6]);
  // A temporary build says why nothing reads as wired.
  assert.match(
    clientsRow([
      { code: "CLIENT_ENGINE_TEMPORARY" },
      { code: "CLIENT_NOT_WIRED" },
    ]).value,
    /^0 of 1 \(temporary engine/,
  );
});

test("sessions: verified means proven; a task id must be non-empty", () => {
  const sessions = [
    { verificationStatus: "proven", taskId: "T-1" },
    { verificationStatus: "unknown", taskId: null },
    { verificationStatus: "not_proven", taskId: " " },
    { verificationStatus: "unknown", taskId: null },
  ];
  assert.equal(sessionsVerifiedRow(sessions).value, "1 of 4 (25%)");
  assert.equal(sessionsWithTaskRow(sessions).value, "1 of 4 (25%)");
  // No sessions is n/a, never a fake 0%.
  assert.equal(sessionsVerifiedRow([]).value, "0 of 0 (n/a)");
});

test("memory writes: unknown or empty source is unattributed; reviews are not writes", () => {
  const row = memoryWritesRow([
    { action: "create", source: "claude-code" },
    { action: "propose", source: "codex" },
    { action: "delete", source: "unknown" },
    { action: "update", source: "" },
    { action: "approve", source: "owner-review" },
    { action: "reject", source: "owner-review" },
  ]);
  assert.equal(row.value, "2 of 4 (50%)");
});

test("tasks: a verify or verified field is evidence; anything else is not", () => {
  const row = tasksVerifiedRow([
    { id: "T-1", verify: "pnpm test" },
    { id: "T-2", verified: "yes" },
    { id: "T-3", state: "done" },
  ]);
  assert.equal(row.value, "2 of 3 (66.7%)");
});

test("search: mode from the index; hit@5 is n/a until an eval exists", () => {
  const [mode, missing] = searchRows(
    { built: true, hasVectors: false, stale: false },
    null,
  );
  assert.equal(mode.value, "fts");
  assert.equal(missing.pendingTask, "T-321");
  assert.match(missing.value, /^n\/a/);
  assert.equal(
    searchRows({ built: true, hasVectors: true, stale: true }, null)[0].value,
    "hybrid (stale)",
  );
  assert.equal(
    searchRows({ built: false, hasVectors: false, stale: true }, null)[0].value,
    "no index",
  );
  assert.equal(
    searchRows(
      { built: true, hasVectors: true, stale: false },
      { hitAt5: 0.85, at: "2026-11-20T01:00:00.000Z" },
    )[1].value,
    "85% on 2026-11-20",
  );
});

test("schedules count enabled of all", () => {
  assert.equal(schedulesRow([]).value, "0 of 0");
  assert.equal(
    schedulesRow([{ enabled: true }, { enabled: false }]).value,
    "1 of 2",
  );
});

test("lessons: active by status; used is n/a until a lesson records hits", () => {
  const [active, used] = lessonsRows([
    { status: "active" },
    { status: "active" },
    { status: "retired" },
  ]);
  assert.equal(active.value, "2 of 3");
  assert.equal(used.pendingTask, "T-323");
  const [, tracked] = lessonsRows([
    { status: "active", hits: "3" },
    { status: "active", hits: "0" },
  ]);
  assert.equal(tracked.value, "1 of 2 (50%)");
});

test("tokens: summed from a provider's result usage; zero or missing usage is not a report", () => {
  const result = (usage) => ({
    type: "json",
    data: JSON.stringify({ type: "result", usage }),
  });
  assert.equal(
    sessionTokens([
      { type: "provider_output", data: '"usage" in plain text' },
      result({
        input_tokens: 2,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 50,
        output_tokens: 8,
      }),
      { type: "json", data: '{"type":"assistant","usage":{"input_tokens":9}}' },
      { type: "json", data: '{"usage": broken' },
    ]),
    160,
  );
  assert.equal(
    sessionTokens([result({ input_tokens: 0, output_tokens: 0 })]),
    null,
  );
  assert.equal(sessionTokens([]), null);
  assert.match(
    tokensRow({ sessions: 10, reporting: 0, total: 0 }).value,
    /^n\/a/,
  );
  assert.equal(
    tokensRow({ sessions: 10, reporting: 2, total: 3000 }).value,
    "1,500 avg over 2 of 10 sessions that report usage",
  );
  assert.equal(hygieneRow().pendingTask, "T-322");
});

test("the 2026-11-18 baseline shape reproduces, then renders as table and markdown", async () => {
  const rows = scorecardRows({
    clients: [
      ...Array(2).fill({ code: "CLIENT_WIRED" }),
      ...Array(10).fill({ code: "CLIENT_CHECK_PENDING" }),
    ],
    sessions: Array(3284).fill({ verificationStatus: "unknown", taskId: null }),
    memoryAudit: [{ action: "create", source: "unknown" }],
    tasks: Array(20).fill({ state: "todo" }),
    search: { built: true, hasVectors: false, stale: false },
    searchEval: null,
    schedules: [],
    lessons: Array(5).fill({ status: "active" }),
    tokens: { sessions: 3284, reporting: 0, total: 0 },
  });
  const value = (id) => rows.find((row) => row.id === id).value;
  assert.equal(value("clients"), "2 of 12");
  assert.equal(value("sessions-verified"), "0 of 3284 (0%)");
  assert.equal(value("sessions-task"), "0 of 3284 (0%)");
  assert.equal(value("memory-writes"), "0 of 1 (0%)");
  assert.equal(value("tasks-verify"), "0 of 20 (0%)");
  assert.equal(value("search-mode"), "fts");
  assert.equal(value("schedules"), "0 of 0");
  // Every n/a row names what it is waiting for.
  for (const row of rows.filter((r) => r.value.startsWith("n/a")))
    assert.ok(row.pendingTask || row.id === "tokens", row.id);
  const table = renderTable(rows);
  assert.match(table, /^Clients confirmed working {2,}2 of 12$/m);
  await withRoot(async (root) => {
    const file = await writeScorecard(rows, "2026-11-18");
    assert.equal(
      file,
      path.join(root, "01-daily", "scorecard", "2026-11-18.md"),
    );
    const text = await readFile(file, "utf8");
    assert.equal(text, renderMarkdown(rows, "2026-11-18"));
    assert.match(text, /^date: 2026-11-18$/m);
    assert.match(text, /^\| Clients confirmed working \| 2 of 12 \| /m);
  });
});

test("readers: live tasks of every project and lesson files, skipping archive and CONFLICTS", async () => {
  await withRoot(async (root) => {
    await write(
      root,
      "04-projects/personal/alpha/tasks/T-1/task.md",
      "---\nid: T-1\nverify: pnpm test\n---\n",
    );
    await write(
      root,
      "04-projects/company/beta/tasks/B-2/task.md",
      "---\nid: B-2\nstate: todo\n---\n",
    );
    await write(
      root,
      "04-projects/personal/alpha/tasks/archive/T-0/task.md",
      "---\nid: T-0\n---\n",
    );
    const tasks = await readTaskFrontmatter();
    assert.deepEqual(tasks.map((t) => t.id).sort(), ["B-2", "T-1"]);
    assert.equal(tasksVerifiedRow(tasks).value, "1 of 2 (50%)");

    await write(
      root,
      "05-knowledge/lessons/a.md",
      "---\nstatus: active\n---\n",
    );
    await write(
      root,
      "05-knowledge/lessons/b.md",
      "---\nstatus: retired\n---\n",
    );
    await write(
      root,
      "05-knowledge/lessons/CONFLICTS.md",
      "---\nstatus: active\n---\n",
    );
    await write(
      root,
      "05-knowledge/lessons/archive/c.md",
      "---\nstatus: active\n---\n",
    );
    const lessons = await readLessonFrontmatter();
    assert.equal(lessonsRows(lessons)[0].value, "1 of 2");
  });
});
