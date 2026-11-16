import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reindexBrain } from "@ocean/brain/brain/brain-reindex.js";
import { brainSearch } from "@ocean/brain/brain/brain-service.js";
import { archiveRetiredLessons } from "@ocean/brain/memory/lessons.js";
import {
  distillWeek,
  goalNames,
  isoWeek,
  reviewMonth,
} from "@ocean/services/distill/distill.js";
import { previousMonth } from "../dist/interfaces/cli/distill-command.js";
import { defaultBrainIndexPort as indexPort } from "../dist/composition/runtime.js";

// T-314: a week of records becomes one digest and review candidates; retired lessons leave search.

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-distill-"));
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

const record = (date, title, extra = "") =>
  `---\ntype: session\nproject: "p"\nprovider: "claude"\nstatus: completed\nsession_id: "s"\ndate: ${date}\ntags: []\ndistilled: false\n---\n\n# ${title}\n\n## Goal\n\n${title}\n${extra}\nRaw events: \`ocean session events s\`\n`;

test("isoWeek gives the ISO label and Monday..Sunday", () => {
  assert.deepEqual(isoWeek("2026-11-16"), {
    label: "2026-W47",
    from: "2026-11-16",
    to: "2026-11-22",
  });
  assert.deepEqual(isoWeek("2027-01-01"), {
    label: "2026-W53",
    from: "2026-12-28",
    to: "2027-01-03",
  });
});

test("distill --week writes a digest, proposes decisions and lessons, marks records, archives processed captures", async () => {
  await withRoot(async (root) => {
    for (const [dir, index] of [
      ["02-personal", "MEMORY.md"],
      ["05-knowledge", "KNOWLEDGE.md"],
    ])
      await write(root, `${dir}/${index}`, "# Index\n");
    await write(
      root,
      "01-daily/sessions/2026-11/a.md",
      record(
        "2026-11-17",
        "Ship routing",
        "\n## Decisions\n\nOne table routes every type.\n- Second decision stays too.\n\n## Learned\n\n- [x] Biome reorders imports\n",
      ),
    );
    await write(
      root,
      "01-daily/sessions/2026-11/b.md",
      record("2026-11-10", "Last week"),
    );
    await write(
      root,
      "01-daily/briefs/2026-11-18.md",
      "---\ntype: brief\n---\n",
    );
    await write(
      root,
      "00-inbox/captures/done.md",
      "---\ntype: capture\nstatus: processed\n---\n\nx\n",
    );
    await write(
      root,
      "00-inbox/captures/open.md",
      "---\ntype: capture\n---\n\ny\n",
    );
    const dry = await distillWeek({ date: "2026-11-19", apply: false });
    assert.deepEqual(dry, {
      week: "2026-W47",
      digest: "01-daily/weekly/2026-W47.md",
      sessions: ["01-daily/sessions/2026-11/a.md"],
      candidates: [],
      archived: ["00-inbox/archive/2026-W47/done.md"],
    });
    await assert.rejects(readFile(path.join(root, dry.digest)));
    const done = await distillWeek({ date: "2026-11-19", apply: true });
    const digest = await readFile(path.join(root, done.digest), "utf8");
    assert.match(digest, /^---\ntype: weekly\nweek: 2026-W47\n/);
    assert.match(
      digest,
      /\[Ship routing\]\(\.\.\/sessions\/2026-11\/a\.md\) — completed/,
    );
    assert.match(
      digest,
      /## Decisions\n\n- \[Ship routing\].*One table routes every type\./,
    );
    assert.match(digest, /\[2026-11-18\]\(\.\.\/briefs\/2026-11-18\.md\)/);
    assert.ok(!digest.includes("Last week"));
    // A section with several lines is taken whole.
    assert.ok(digest.includes("Second decision stays too."));
    assert.equal(done.candidates.length, 2);
    assert.match(
      await readFile(path.join(root, done.candidates[0]), "utf8"),
      /kind: "decision"/,
    );
    assert.match(
      await readFile(path.join(root, "01-daily/sessions/2026-11/a.md"), "utf8"),
      /^distilled: true$/m,
    );
    assert.match(
      await readFile(path.join(root, "01-daily/sessions/2026-11/b.md"), "utf8"),
      /^distilled: false$/m,
    );
    assert.deepEqual(await readdir(path.join(root, "00-inbox/captures")), [
      "open.md",
    ]);
    assert.deepEqual(
      await readdir(path.join(root, "00-inbox/archive/2026-W47")),
      ["done.md"],
    );
    assert.deepEqual(
      (await distillWeek({ date: "2026-11-19", apply: false })).sessions,
      [],
    );
  });
});

test("retired records leave search; archive-retired moves retired lessons, keeping them", async () => {
  await withRoot(async (root) => {
    const lesson = (status) =>
      `---\ntitle: Lighthouse storms\ntype: lesson\nstatus: ${status}\n---\n\nThe lighthouse logs storms.\n`;
    await write(root, "05-knowledge/lessons/old.md", lesson("retired"));
    await write(root, "05-knowledge/lessons/live.md", lesson("active"));
    await write(
      root,
      "01-daily/sessions/2026-11/s.md",
      record("2026-11-17", "Lighthouse session"),
    );
    const result = await reindexBrain({ root, indexPort, embedder: null });
    assert.equal(result.docs, 2);
    const hits = await brainSearch({ root, indexPort, query: "lighthouse" });
    assert.deepEqual(hits.results.map((hit) => hit.path).sort(), [
      "knowledge/lessons/live.md",
      "sessions/2026-11/s.md",
    ]);
    assert.deepEqual(await archiveRetiredLessons({ apply: false }), ["old.md"]);
    await archiveRetiredLessons({ apply: true });
    assert.deepEqual(await readdir(path.join(root, "05-knowledge/lessons")), [
      "archive",
      "live.md",
    ]);
    assert.deepEqual(
      await readdir(path.join(root, "05-knowledge/lessons/archive")),
      ["old.md"],
    );
  });
});

test("a week with only processed captures still archives them; quoted retired lessons are archived", async () => {
  await withRoot(async (root) => {
    await write(
      root,
      "00-inbox/captures/done.md",
      "---\ntype: capture\nstatus: processed\n---\n\nx\n",
    );
    const result = await distillWeek({ date: "2026-11-19", apply: true });
    assert.equal(result.digest, null);
    assert.deepEqual(
      await readdir(path.join(root, "00-inbox/archive/2026-W47")),
      ["done.md"],
    );
    await write(
      root,
      "05-knowledge/lessons/q.md",
      '---\nstatus: "retired"\n---\n\nq\n',
    );
    assert.deepEqual(await archiveRetiredLessons({ apply: false }), ["q.md"]);
  });
});

test("the monthly review sets the month's weeks and milestones beside the active goals, once", async () => {
  assert.equal(previousMonth("2026-01-05"), "2025-12");
  assert.equal(previousMonth("2026-11-16"), "2026-10");
  await withRoot(async (root) => {
    assert.equal(
      (await reviewMonth({ month: "2026-10", apply: true })).review,
      null,
    );
    await write(
      root,
      "02-personal/goals.md",
      "---\nname: goals\n---\n\n# Goals\n\n- **Back-end mastery (NestJS).** detail\n- **IELTS 6.5–7.0.** detail\n\n## Set aside\n\n- **Ship a SaaS** later\n",
    );
    assert.deepEqual(await goalNames(), [
      "Back-end mastery (NestJS)",
      "IELTS 6.5–7.0",
    ]);
    await write(
      root,
      "01-daily/weekly/2026-W40.md",
      "---\ntype: weekly\nfrom: 2026-09-28\nto: 2026-10-04\n---\n",
    );
    await write(
      root,
      "01-daily/weekly/2026-W45.md",
      "---\ntype: weekly\nfrom: 2026-11-02\nto: 2026-11-08\n---\n",
    );
    await write(
      root,
      "01-daily/sessions/2026-10/a.md",
      record("2026-10-03", "A"),
    );
    await write(
      root,
      "02-personal/milestones/cert.md",
      "---\ntype: milestone\ndate: 2026-10-20\nkind: certificate\nstatus: done\n---\n\n# NestJS certificate\n",
    );
    const dry = await reviewMonth({ month: "2026-10", apply: false });
    assert.deepEqual(dry.weeks, ["01-daily/weekly/2026-W40.md"]);
    assert.deepEqual(dry.milestones, ["NestJS certificate"]);
    assert.equal(dry.sessions, 1);
    await assert.rejects(
      readFile(path.join(root, "01-daily/monthly/2026-10.md")),
    );
    await reviewMonth({ month: "2026-10", apply: true });
    const file = path.join(root, "01-daily/monthly/2026-10.md");
    const text = await readFile(file, "utf8");
    assert.match(text, /^type: monthly$/m);
    assert.match(text, /^- \[ \] \*\*Back-end mastery \(NestJS\)\*\* — $/m);
    assert.doesNotMatch(text, /Ship a SaaS/);
    assert.match(text, /\[2026-W40\]\(\.\.\/weekly\/2026-W40\.md\)/);
    // The owner's answers survive a rerun.
    await writeFile(file, `${text}\nmine\n`);
    await reviewMonth({ month: "2026-10", apply: true });
    assert.match(await readFile(file, "utf8"), /\nmine\n$/);
  });
});
