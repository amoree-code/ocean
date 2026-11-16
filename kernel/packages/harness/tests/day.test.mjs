import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  dropEmptyStubs,
  openLoops,
  prepareDay,
  upcoming,
} from "@ocean/services/day/day.js";
import { keepTicks, putBlock } from "@ocean/services/day/note.js";
import { harvestDay } from "@ocean/services/harvest/harvest.js";

// T-314: one daily note — Ocean's morning block under the title, the day's account before the
// owner's own Notes, both rewritten in place, his text and ticks kept.

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-day-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    for (const [dir, index] of [
      ["02-personal", "MEMORY.md"],
      ["05-knowledge", "KNOWLEDGE.md"],
    ])
      await write(
        root,
        `${dir}/${index}`,
        "# Index\n\n## Records (generated)\n",
      );
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

test("blocks: morning under the title, the day's account before Notes, the owner's text kept", () => {
  let note = putBlock(null, "2026-11-17", "harvest", "## Day summary\n\nx");
  assert.match(
    note,
    /^---\ntype: daily\ndate: 2026-11-17\n---\n\n# 2026-11-17 — Tuesday\n\n<!-- ocean:harvest:start -->/,
  );
  note = note.replace("## Notes\n", "## Notes\n\nMine.\n");
  note = putBlock(note, "2026-11-17", "day", "## Today\n\nfocus");
  note = putBlock(note, "2026-11-17", "harvest", "## Day summary\n\ny");
  assert.ok(
    note.indexOf("ocean:day:start") < note.indexOf("ocean:harvest:start"),
  );
  assert.ok(note.indexOf("ocean:harvest:end") < note.indexOf("## Notes"));
  assert.match(note, /## Day summary\n\ny/);
  assert.doesNotMatch(note, /\nx\n/);
  assert.match(note, /Mine\./);
  // A note from before, with no blocks and its own sections, keeps them.
  const old = putBlock(
    "# Daily — 2026-11-15\n\n## Work log\n- 10:00 a\n",
    "2026-11-15",
    "day",
    "## Today",
  );
  assert.match(
    old,
    /^# Daily — 2026-11-15\n\n<!-- ocean:day:start -->\n## Today\n<!-- ocean:day:end -->\n\n## Work log\n- 10:00 a/,
  );
  // The old template's empty headings go; one with content stays.
  assert.equal(
    dropEmptyStubs("# d\n\n## Focus\n\n## Work log\n- 10:00 a\n\n## Decisions\n\n## Notes\n"),
    "# d\n\n## Work log\n- 10:00 a\n\n## Notes\n",
  );
  // Ticks the owner made inside a block survive the rewrite.
  assert.equal(
    keepTicks(
      "- [x] Ship it ([s](a.md))",
      "- [ ] Ship it ([s](a.md))\n- [ ] Other",
    ),
    "- [x] Ship it ([s](a.md))\n- [ ] Other",
  );
});

test("coming up: dated lines in the owner's records within 30 days, not frontmatter, not the past", async () => {
  await withRoot(async (root) => {
    await write(
      root,
      "02-personal/education/open-doors.md",
      "---\ncreated: 2026-11-20\n---\n\n| Exam | Date |\n| --- | --- |\n| Engineering | Wed 2026-11-25 |\n\nOld: 2026-10-01. Far: 2027-03-01. Checked 2026-11-16.\n",
    );
    // Today's date as a "checked on" note is not an event; an exam today is.
    assert.equal((await upcoming("2026-11-16")).length, 1);
    await write(root, "02-personal/schedule/today.md", "- Mock exam 2026-11-16 at 18:00\n");
    assert.equal((await upcoming("2026-11-16")).length, 2);
    await write(root, "02-personal/schedule/today.md", "");
    assert.deepEqual(await upcoming("2026-11-16"), [
      "2026-11-25 (in 9 days) — Engineering Wed 2026-11-25 ([open-doors](../02-personal/education/open-doors.md))",
    ]);
  });
});

test("open loops carry forward until ticked; the morning block lists them with tasks, hours and the brief", async () => {
  await withRoot(async (root) => {
    await write(
      root,
      "01-daily/sessions/2026-11/a.md",
      '---\ntype: session\nproject: "shop"\nprovider: "claude"\nstatus: completed\ndate: 2026-11-15\n---\n\n# Cart\n\n## Goal\n\nCart.\n\n## Next\n\n- Ship the checkout page with new totals.\n- Write the release notes for the shop.\n',
    );
    await harvestDay({ date: "2026-11-15", apply: true });
    // He ticks one in yesterday's note.
    const file = path.join(root, "01-daily/2026-11-15.md");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(
        "- [ ] Write the release",
        "- [x] Write the release",
      ),
    );
    assert.deepEqual(
      (await openLoops("2026-11-16")).map((line) =>
        line.replace(/ \(\[.*$/, ""),
      ),
      ["- [ ] Ship the checkout page with new totals."],
    );
    await write(
      root,
      "04-projects/personal/ocean/tasks/T-1/task.md",
      "---\nid: T-1\ntitle: Daily note\nstate: active\ngoal: one note per day\n---\n",
    );
    await write(
      root,
      "02-personal/schedule/hours.md",
      "# Hours\n\n- Study: 18:00–22:00.\n",
    );
    await write(
      root,
      "02-personal/interests/claude.md",
      "---\ntype: interest\npriority: high\nsources: [github:anthropics/claude-code]\n---\n\n# Claude Code\n",
    );
    const feed =
      '<feed><entry><title>v2.1 released</title><link href="https://github.com/anthropics/claude-code/releases/v2.1"/><updated>2026-11-15T00:00:00Z</updated></entry></feed>';
    const plan = await prepareDay({
      date: "2026-11-16",
      apply: true,
      fetchText: async () => feed,
    });
    const note = await readFile(
      path.join(root, "01-daily/2026-11-16.md"),
      "utf8",
    );
    assert.match(note, /### Focus\n\n- T-1 — Daily note\n/);
    assert.match(
      note,
      /### Open loops\n\n- \[ \] Ship the checkout page with new totals\..*_\(from 2026-11-15\)_/,
    );
    assert.match(note, /### Your hours\n\n- Study: 18:00–22:00\./);
    assert.match(
      note,
      /## Brief\n\n- \*\*Claude Code\*\* — \[v2\.1 released\]/,
    );
    assert.match(note, /Full brief: \[2026-11-16\]\(briefs\/2026-11-16\.md\)/);
    assert.equal(plan.loops.length, 1);
    // A rerun replaces the block; a tick made in it is kept.
    await writeFile(
      path.join(root, "01-daily/2026-11-16.md"),
      note.replace("- [ ] Ship", "- [x] Ship"),
    );
    await prepareDay({
      date: "2026-11-16",
      apply: true,
      fetchText: async () => feed,
    });
    const again = await readFile(
      path.join(root, "01-daily/2026-11-16.md"),
      "utf8",
    );
    assert.equal(again.split("<!-- ocean:day:start -->").length, 2);
    assert.match(again, /- \[x\] Ship the checkout page/);
  });
});
