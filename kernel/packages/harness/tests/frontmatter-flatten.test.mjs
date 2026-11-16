import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeRecord } from "@ocean/brain/brain/brain-markdown.js";
import {
  flattenFrontmatter,
  flattenWorkspace,
} from "@ocean/brain/memory/frontmatter-flatten.js";

// T-314: nested `metadata:` moves to top level so Obsidian Properties and Bases can read it.

test("flattenFrontmatter lifts metadata keys, keeps top-level values, moves lists whole", () => {
  const source = [
    "---",
    "name: deploy",
    "status: draft",
    "metadata:",
    "  type: decision",
    "  status: current",
    "  tags:",
    "    - infra",
    "    - ci",
    "updated: 2026-11-01",
    "---",
    "",
    "# Deploy",
    "",
  ].join("\n");
  assert.equal(
    flattenFrontmatter(source),
    [
      "---",
      "name: deploy",
      "status: draft",
      "type: decision",
      "tags:",
      "  - infra",
      "  - ci",
      "updated: 2026-11-01",
      "---",
      "",
      "# Deploy",
      "",
    ].join("\n"),
  );
  assert.equal(flattenFrontmatter("---\ntype: note\n---\n\nbody\n"), null);
  assert.equal(flattenFrontmatter("no frontmatter\nmetadata:\n  a: b\n"), null);
  // The reader sees the same type before and after.
  for (const text of [source, flattenFrontmatter(source)])
    assert.equal(normalizeRecord("memory/x.md", text).record.type, "decision");
});

test("flatten is a dry run until --yes, skips 07-notes, backs up and keeps permissions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-flatten-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    const nested = "---\nmetadata:\n  type: feedback\n---\n\nx\n";
    for (const file of [
      "02-personal/work/a.md",
      "05-knowledge/decisions/b.md",
      "07-notes/mine.md",
    ]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), nested, { mode: 0o600 });
    }
    const dry = await flattenWorkspace({ apply: false });
    assert.deepEqual(dry, {
      changed: ["02-personal/work/a.md", "05-knowledge/decisions/b.md"],
      backup: null,
    });
    assert.equal(
      await readFile(path.join(root, "02-personal/work/a.md"), "utf8"),
      nested,
    );
    const applied = await flattenWorkspace({
      apply: true,
      now: new Date("2026-11-15T18:00:00Z"),
    });
    assert.equal(
      applied.backup,
      "bridge/archive/frontmatter-flatten-20261115T180000",
    );
    const file = path.join(root, "02-personal/work/a.md");
    assert.equal(
      await readFile(file, "utf8"),
      "---\ntype: feedback\n---\n\nx\n",
    );
    // Windows has no POSIX permission bits to keep.
    if (process.platform !== "win32")
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(
      await readFile(
        path.join(root, applied.backup, "02-personal/work/a.md"),
        "utf8",
      ),
      nested,
    );
    assert.equal(
      await readFile(path.join(root, "07-notes/mine.md"), "utf8"),
      nested,
    );
    assert.deepEqual((await flattenWorkspace({ apply: false })).changed, []);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});
