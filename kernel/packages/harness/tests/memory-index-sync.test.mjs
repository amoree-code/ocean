import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The store paths are resolved when the modules load, so the root is set first.
const root = realpathSync(
  await mkdtemp(path.join(os.tmpdir(), "ocean-index-sync-")),
);
process.env.OCEAN_ROOT = root;
const { KNOWLEDGE_DIR, PERSONAL_DIR } = await import(
  "@ocean/core/shared/paths.js"
);
const { doctorMemoryIndexes, syncMemoryIndexes } = await import(
  "@ocean/brain/memory/index-sync.js"
);

async function put(relative, text) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

test.after(() => rm(root, { recursive: true, force: true }));

test("the curated indexes leave lesson records to the brain index, but keep CONFLICTS.md", async () => {
  await put(path.join(PERSONAL_DIR, "MEMORY.md"), "# Memory\n");
  // An index written by an earlier reindex that still lists a lesson record.
  await put(
    path.join(KNOWLEDGE_DIR, "KNOWLEDGE.md"),
    "# Knowledge\n\n- [linked](decisions/linked.md)\n\n## Records (generated)\n\n- [L1](lessons/lesson-obs-1.md)\n",
  );
  await put(path.join(KNOWLEDGE_DIR, "decisions", "linked.md"), "# Linked\n");
  await put(path.join(KNOWLEDGE_DIR, "discoveries", "unlinked.md"), "# U\n");
  await put(path.join(KNOWLEDGE_DIR, "lessons", "lesson-obs-1.md"), "# L1\n");
  await put(path.join(KNOWLEDGE_DIR, "lessons", "lesson-obs-2.md"), "# L2\n");
  await put(path.join(KNOWLEDGE_DIR, "lessons", "CONFLICTS.md"), "# C\n");

  // Lesson records are not demanded; CONFLICTS.md waits on a human, so it is.
  const doctor = await doctorMemoryIndexes();
  assert.deepEqual(doctor.missing.sort(), [
    "knowledge/discoveries/unlinked.md",
    "knowledge/lessons/CONFLICTS.md",
  ]);
  assert.deepEqual(doctor.broken, []);

  // A reindex rewrites the generated section: curated records and CONFLICTS.md, no lesson.
  await syncMemoryIndexes(true);
  const index = await readFile(
    path.join(root, KNOWLEDGE_DIR, "KNOWLEDGE.md"),
    "utf8",
  );
  const generated = index.slice(index.indexOf("## Records (generated)"));
  assert.match(generated, /\(discoveries\/unlinked\.md\)/);
  assert.match(generated, /\(lessons\/CONFLICTS\.md\)/);
  assert.doesNotMatch(generated, /lesson-obs/);
  assert.equal((await doctorMemoryIndexes()).ok, true);
});
