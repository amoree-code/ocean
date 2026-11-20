import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clientsRow,
  driftRow,
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
  writerOf,
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

const writers = {
  clients: new Set([
    "claude-code",
    "codex",
    "local-agent-mode-ocean",
    "claude.ai",
  ]),
  sessionProvider: (id) => (id === "s-1" ? "claude" : null),
};

test("memory writes: a client, a traced session or nothing; the owner and Ocean's jobs are apart", () => {
  for (const [source, kind] of [
    ["claude-code", "client"],
    ["local-agent-mode-ocean", "client"],
    ["claude.ai", "client"],
    ["session:s-1", "client"],
    ["session:desktop:abc", "client"],
    ["session:gone", "unknown"],
    ["t307-ledger-smoke", "unknown"],
    ["unknown", "unknown"],
    ["", "unknown"],
    [undefined, "unknown"],
    ["owner-review", "owner-or-ocean"],
    ["cli", "owner-or-ocean"],
    ["instructions", "owner-or-ocean"],
    ["session-telemetry", "owner-or-ocean"],
    ["distill:2026-W47", "owner-or-ocean"],
  ])
    assert.equal(writerOf(source, writers), kind, String(source));
  const row = memoryWritesRow(
    [
      { action: "create", source: "claude-code" },
      { action: "propose", source: "session:s-1" },
      { action: "delete", source: "unknown" },
      { action: "update", source: "session:gone" },
      { action: "create", source: "owner-review" },
      { action: "propose", source: "distill:2026-W47" },
      // Reviews are not writes.
      { action: "approve", source: "owner-review" },
      { action: "reject", source: "owner-review" },
    ],
    writers,
  );
  assert.equal(
    row.value,
    "2 of 4 (50%); 2 more by the owner or Ocean's own jobs",
  );
  assert.deepEqual([row.n, row.of], [2, 4]);
  // Nothing but the owner's own writes: no client percentage to show.
  assert.equal(
    memoryWritesRow([{ action: "create", source: "owner-review" }], writers)
      .value,
    "0 of 0 (n/a); 1 more by the owner or Ocean's own jobs",
  );
});

test("tasks: a verify or verified field is evidence; anything else is not", () => {
  const row = tasksVerifiedRow([
    { id: "T-1", verify: "pnpm test" },
    { id: "T-2", verified: "yes" },
    { id: "T-3", state: "done" },
  ]);
  assert.equal(row.value, "2 of 3 (66.7%)");
});

test("search: the mode a probe search ran in, why it is not hybrid; hit@5 n/a until an eval", () => {
  const [mode, missing] = searchRows(
    {
      built: true,
      mode: "fts",
      stale: false,
      vector: "unavailable: index built without an embedder",
    },
    null,
  );
  assert.equal(
    mode.value,
    "fts; vectors unavailable: index built without an embedder",
  );
  assert.equal(missing.pendingTask, "T-322");
  assert.match(missing.value, /^n\/a/);
  assert.equal(
    searchRows(
      { built: true, mode: "hybrid", stale: true, vector: "ok" },
      null,
    )[0].value,
    "hybrid; index stale",
  );
  assert.equal(searchRows({ built: false }, null)[0].value, "no index");
  assert.equal(
    searchRows(
      { built: true, mode: "hybrid", stale: false, vector: "ok" },
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
  assert.equal(hygieneRow(null).pendingTask, "T-322");
  assert.equal(
    hygieneRow({
      month: "2026-11",
      records: 50,
      verified: 40,
      drifted: 3,
      unverifiable: 7,
    }).value,
    "40 / 3 / 7 of 50 with claims (2026-11)",
  );
  assert.equal(driftRow(null).pendingTask, "T-322");
  assert.equal(
    driftRow({ records: 500, unrecorded: 2, since: "2026-11-19T01:00:00.000Z" })
      .value,
    "2 of 500 since 2026-11-19",
  );
});

test("the 2026-11-18 baseline shape reproduces, then renders as table and markdown", async () => {
  const rows = scorecardRows({
    clients: [
      ...Array(2).fill({ code: "CLIENT_WIRED" }),
      ...Array(10).fill({ code: "CLIENT_CHECK_PENDING" }),
    ],
    sessions: Array(3284).fill({ verificationStatus: "unknown", taskId: null }),
    memoryAudit: [{ action: "create", source: "unknown" }],
    writers,
    tasks: Array(20).fill({ state: "todo" }),
    search: {
      built: true,
      mode: "fts",
      stale: false,
      vector: "unavailable: index built without an embedder",
    },
    searchEval: null,
    schedules: [],
    lessons: Array(5).fill({ status: "active" }),
    tokens: { sessions: 3284, reporting: 0, total: 0 },
    hygiene: null,
    drift: null,
  });
  const value = (id) => rows.find((row) => row.id === id).value;
  assert.equal(value("clients"), "2 of 12");
  assert.equal(value("sessions-verified"), "0 of 3284 (0%)");
  assert.equal(value("sessions-task"), "0 of 3284 (0%)");
  assert.equal(value("memory-writes"), "0 of 1 (0%)");
  assert.equal(value("tasks-verify"), "0 of 20 (0%)");
  assert.match(value("search-mode"), /^fts; /);
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
