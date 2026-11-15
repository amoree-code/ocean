import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  draft,
  listMilestones,
  writeDraft,
} from "@ocean/services/express/express.js";

// T-314 express: drafts from milestones only — nothing invented, nothing sent.

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-express-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

const milestone = (date, kind, title, status = "done") =>
  `---\ntype: milestone\ndate: ${date}\nkind: ${kind}\nstatus: ${status}\n---\n\n# ${title}\n\nShort note on ${title}.\n`;

test("drafts list done milestones newest first, grouped for a CV, academic ones for a scholarship", async () => {
  await withRoot(async (root) => {
    assert.deepEqual(
      await writeDraft({ kind: "cv", date: "2026-11-16" }).then((r) => r.file),
      null,
    );
    const dir = path.join(root, "02-personal/milestones");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "ielts.md"),
      milestone("2026-09-01", "exam", "IELTS 7.0"),
    );
    await writeFile(
      path.join(dir, "ocean.md"),
      milestone("2026-11-15", "release", "Ocean 1.6"),
    );
    await writeFile(
      path.join(dir, "plan.md"),
      milestone("2027-01-01", "exam", "Planned exam", "planned"),
    );
    await writeFile(
      path.join(dir, "note.md"),
      "---\ntype: note\n---\n\n# Not a milestone\n",
    );
    // No status is not "done"; an empty kind groups as "other"; an unreadable *.md is skipped.
    await writeFile(
      path.join(dir, "nostatus.md"),
      "---\ntype: milestone\ndate: 2026-10-01\n---\n\n# Maybe done\n",
    );
    await writeFile(
      path.join(dir, "blank.md"),
      "---\ntype: milestone\ndate: 2026-08-01\nkind:\nstatus: done\n---\n\n# Blank kind\n",
    );
    await mkdir(path.join(dir, "folder.md"));
    const items = await listMilestones();
    assert.deepEqual(
      items.map((m) => m.title),
      ["Ocean 1.6", "IELTS 7.0", "Blank kind"],
    );
    const cv = draft("cv", items);
    assert.match(cv, /## Other\n\n- \*\*Blank kind\*\*/);
    assert.match(
      cv,
      /## Exam\n\n- \*\*IELTS 7\.0\*\* \(2026-09\) — Short note on IELTS 7\.0\./,
    );
    assert.match(cv, /## Release\n\n- \*\*Ocean 1\.6\*\*/);
    assert.match(
      draft("scholarship", items),
      /My preparation so far: IELTS 7\.0 \(2026\)\./,
    );
    assert.ok(!draft("scholarship", items).includes("Ocean"));
    assert.ok(!draft("linkedin", items).includes("Planned exam"));
    const written = await writeDraft({ kind: "linkedin", date: "2026-11-16" });
    assert.equal(written.file, "00-inbox/drafts/linkedin-2026-11-16.md");
    assert.match(
      await readFile(path.join(root, written.file), "utf8"),
      /^---\ntype: draft\nkind: linkedin\n/,
    );
  });
});
