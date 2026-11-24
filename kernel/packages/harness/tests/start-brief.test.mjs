import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  lastProjectSession,
  START_BRIEF_MAX_BYTES,
  startBrief,
} from "@ocean/loop/hooks/start-brief.js";
import { weeklyPatterns } from "@ocean/services/distill/patterns.js";

// T-329 phase 5: a few pointer lines at session start, and the weekly digest's counts.

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-start-brief-"));
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

const task = (id, state, updated, next = "") =>
  `---\nid: ${id}\ntitle: "Task ${id}"\nstate: ${state}\nupdated: ${updated}\n---\n\n## Objective\n\nDo ${id}.\n${next ? `\n## Next action\n\n${next}\nsecond line\n\nLater paragraph.\n` : ""}`;

const session = (project, date, title, next = "") =>
  `---\ntype: session\nproject: "${project}"\nprovider: "claude"\nstatus: completed\ndate: ${date}\n---\n\n# ${title}\n\n## Goal\n\nx\n${next ? `\n## Next\n\n- ${next}\n- another\n` : ""}`;

test("start brief: live tasks newest first with next action, then the project's last session", async () => {
  await withRoot(async (root) => {
    const tasks = "04-projects/demo/tasks";
    await write(
      root,
      `${tasks}/T-001/task.md`,
      task("T-001", "in-qa", "2026-11-20", "Owner merges #1"),
    );
    await write(
      root,
      `${tasks}/T-002/task.md`,
      task("T-002", "active", "2026-11-24", "Write the tests"),
    );
    await write(
      root,
      `${tasks}/T-003/task.md`,
      task("T-003", "done", "2026-11-25"),
    );
    await write(
      root,
      `${tasks}/T-004/task.md`,
      task("T-004", "paused", "2026-11-25"),
    );
    await write(
      root,
      "01-daily/sessions/2026-11/2026-11-23-1000-a.md",
      session("demo", "2026-11-23", "Older", "old step"),
    );
    await write(
      root,
      "01-daily/sessions/2026-11/2026-11-24-0900-b.md",
      session("demo", "2026-11-24", "Newest demo", "Run the suite"),
    );
    await write(
      root,
      "01-daily/sessions/2026-11/2026-11-25-0800-c.md",
      session("other", "2026-11-25", "Other project"),
    );
    await write(
      root,
      "01-daily/sessions/archive/2026-11-26-0800-d.md",
      session("demo", "2026-11-26", "Archived"),
    );
    const brief = await startBrief("demo");
    assert.equal(
      brief,
      [
        "Start brief (demo):",
        "- T-002 active: Task T-002 — next: Write the tests second line",
        "- T-001 in-qa: Task T-001 — next: Owner merges #1 second line",
        "- Last session 2026-11-24: Newest demo — next: Run the suite",
      ].join("\n"),
    );
  });
});

test("start brief: nothing to say is null; the budget keeps whole items only", async () => {
  await withRoot(async (root) => {
    assert.equal(await startBrief("demo"), null);
    assert.equal(await lastProjectSession("demo"), null);
    for (let index = 1; index <= 3; index++)
      await write(
        root,
        `04-projects/demo/tasks/T-00${index}/task.md`,
        task(
          `T-00${index}`,
          "blocked",
          `2026-11-2${index}`,
          "word ".repeat(80),
        ),
      );
    await write(
      root,
      "01-daily/sessions/2026-11/2026-11-24-0900-b.md",
      session("demo", "2026-11-24", "x ".repeat(200)),
    );
    const brief = await startBrief("demo");
    assert.ok(Buffer.byteLength(brief) <= START_BRIEF_MAX_BYTES);
    for (const line of brief.split("\n").slice(1)) {
      assert.ok(line.length <= 172);
      assert.match(line, /^- (T-00\d blocked|Last session)/);
    }
    assert.match(brief, /^Start brief \(demo\):\n- T-003 blocked/);
  });
});

test("weekly patterns: counts by project, client, status; untitled share; repeated tasks and failures; open next steps", () => {
  const item = (project, provider, status, text, untitled = false) => ({
    text,
    title: "t",
    status,
    project,
    provider,
    untitled,
  });
  const lines = weeklyPatterns(
    [
      item(
        "ocean",
        "claude",
        "completed",
        "T-9 and T-9 again\n## Next\n\n- go\n",
      ),
      item("ocean", "codex", "completed", "on T-9, T-4\n", true),
      item("", "claude", "", "T-4 once more\n## Next\n\n"),
    ],
    [
      { label: "handoff-empty-title", sessions: 2 },
      { label: "once/only", sessions: 1 },
    ],
  );
  assert.deepEqual(lines, [
    "- Projects: ocean 2 · none 1",
    "- Clients: claude 2 · codex 1",
    "- Status: completed 2 · unknown 1",
    "- Untitled: 1 of 3 (33%)",
    "- Tasks across sessions: T-4 2 · T-9 2",
    "- Repeated failures: handoff-empty-title 2",
    "- Left a next step: 1 of 3",
  ]);
  assert.deepEqual(weeklyPatterns([]), []);
});
