import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseFrontmatter } from "@ocean/core/shared/fs-utils.js";
import {
  curate,
  curatorStateFile,
  judge,
  reviewCurated,
} from "@ocean/services/curator/curator.js";

// T-322: the curator marks stale at 30 days, archives at 90, never on missing data, and every
// mark is undone by `review`.

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-curator-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

const exists = (file) =>
  stat(file).then(
    () => true,
    () => false,
  );

const LESSON = `---
type: lesson
title: "A test lesson"
status: active
created: 2026-01-01
last_verified: 2026-01-01
---

# A test lesson

Body stays untouched.
`;

const SKILL = `---
name: demo-skill
description: A demo skill that wraps
  onto a second line.
date_added: 2026-01-01
---

# Demo
`;

async function seed(root) {
  const lessons = path.join(root, "05-knowledge", "lessons");
  await mkdir(lessons, { recursive: true });
  await writeFile(path.join(lessons, "test-lesson.md"), LESSON);
  const skill = path.join(root, "bridge", "skills", "demo-skill");
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), SKILL);
  return {
    lesson: path.join(lessons, "test-lesson.md"),
    archived: path.join(lessons, "archive", "test-lesson.md"),
    skill: path.join(skill, "SKILL.md"),
  };
}

test("judge: the clock starts at first sight; stale at 30, archived at 90, stale when unreviewed", () => {
  const old = { last_verified: "2026-01-01" };
  assert.equal(judge(old, "2026-11-20", "2026-11-20").status, "fresh");
  assert.deepEqual(judge(old, "2026-10-21", "2026-11-20"), {
    status: "stale",
    reason: "unused 30 days",
  });
  assert.equal(judge(old, "2026-08-22", "2026-11-20").status, "archived");
  // A recent use keeps it fresh until review age catches up.
  assert.deepEqual(
    judge({ last_used: "2026-11-19" }, "2026-08-22", "2026-11-20"),
    { status: "stale", reason: "not reviewed for 90 days" },
  );
  assert.equal(
    judge(
      { last_used: "2026-11-19", last_reviewed: "2026-11-01" },
      "2026-01-01",
      "2026-11-20",
    ).status,
    "fresh",
  );
});

test("first run marks nothing, even for records with old dates", async () => {
  await withRoot(async (root) => {
    const files = await seed(root);
    assert.deepEqual(await curate({ today: "2026-11-20", apply: true }), []);
    const state = JSON.parse(await readFile(curatorStateFile(), "utf8"));
    assert.deepEqual(state.firstSeen, {
      "lesson:test-lesson": "2026-11-20",
      "skill:demo-skill": "2026-11-20",
    });
    assert.equal(await readFile(files.lesson, "utf8"), LESSON);
  });
});

test("curator marks a test lesson stale, archives it, and review restores it", async () => {
  await withRoot(async (root) => {
    const files = await seed(root);
    await curate({ today: "2026-08-01", apply: true });

    // Dry run changes nothing.
    const preview = await curate({ today: "2026-09-01", apply: false });
    assert.deepEqual(
      preview.map((item) => [item.key, item.action]),
      [
        ["lesson:test-lesson", "stale"],
        ["skill:demo-skill", "stale"],
      ],
    );
    assert.equal(await readFile(files.lesson, "utf8"), LESSON);

    await curate({ today: "2026-09-01", apply: true });
    let fields = parseFrontmatter(await readFile(files.lesson, "utf8"));
    assert.equal(fields.status, "stale");
    assert.equal(fields.curator_from, "active");
    assert.equal(fields.curated_at, "2026-09-01");
    // Marking again the next day is a no-op.
    assert.deepEqual(await curate({ today: "2026-09-02", apply: true }), []);

    await curate({ today: "2026-11-20", apply: true });
    assert.equal(await exists(files.lesson), false);
    fields = parseFrontmatter(await readFile(files.archived, "utf8"));
    assert.equal(fields.status, "archived");
    assert.equal(fields.curator_from, "active");

    const reviewed = await reviewCurated("test-lesson", "2026-11-21");
    assert.deepEqual(reviewed, {
      key: "lesson:test-lesson",
      file: files.lesson,
      restored: true,
    });
    assert.equal(await exists(files.archived), false);
    const restored = await readFile(files.lesson, "utf8");
    assert.equal(
      restored,
      LESSON.replace(
        "last_verified: 2026-01-01\n",
        "last_verified: 2026-01-01\nlast_reviewed: 2026-11-21\n",
      ),
    );
    // Reviewed lesson is fresh again; the already-archived skill needs nothing new.
    assert.deepEqual(await curate({ today: "2026-11-22", apply: true }), []);
  });
});

test("a skill is marked in place, never moved, and review removes the mark", async () => {
  await withRoot(async (root) => {
    const files = await seed(root);
    await curate({ today: "2026-08-01", apply: true });
    await curate({ today: "2026-11-20", apply: true });
    const marked = await readFile(files.skill, "utf8");
    const fields = parseFrontmatter(marked);
    assert.equal(fields.status, "archived");
    assert.equal(fields.curator_from, "none");
    assert.match(
      marked,
      /description: A demo skill that wraps\n {2}onto a second line\./,
    );

    const reviewed = await reviewCurated("skill:demo-skill", "2026-11-21");
    assert.equal(reviewed.restored, true);
    assert.equal(
      await readFile(files.skill, "utf8"),
      SKILL.replace(
        "date_added: 2026-01-01\n",
        "date_added: 2026-01-01\nlast_reviewed: 2026-11-21\n",
      ),
    );
    assert.deepEqual(await curate({ today: "2026-11-22", apply: true }), []);
  });
});

test("retired lessons archived by T-314 are not pulled back by the curator", async () => {
  await withRoot(async (root) => {
    const archive = path.join(root, "05-knowledge", "lessons", "archive");
    await mkdir(archive, { recursive: true });
    await writeFile(
      path.join(archive, "old.md"),
      "---\ntype: lesson\nstatus: retired\n---\n",
    );
    assert.deepEqual(await curate({ today: "2026-11-20", apply: true }), []);
    await assert.rejects(reviewCurated("old", "2026-11-20"), /Not a lesson/);
  });
});
