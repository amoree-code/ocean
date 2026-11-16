import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reindexBrain } from "@ocean/brain/brain/brain-reindex.js";
import { brainSearch } from "@ocean/brain/brain/brain-service.js";
import { permanentRecord } from "@ocean/brain/memory/memory-paths.js";
import { MemoryContractError } from "@ocean/core/domain/mcp/memory-contract.js";
import { NOTES_DIR, STORE_DIR } from "@ocean/core/shared/paths.js";
import { defaultBrainIndexPort as indexPort } from "../dist/composition/runtime.js";

// T-314: 07-notes is the owner's own writing. Agents read and index it, never write it, and
// on the same question it ranks above what agents wrote.

test("a record path under 07-notes is refused as PROTECTED", () => {
  for (const target of [`${NOTES_DIR}/idea.md`, `${NOTES_DIR}/deep/x.md`])
    assert.throws(
      () => permanentRecord(target),
      (error) =>
        error instanceof MemoryContractError && error.code === "PROTECTED",
    );
});

test("07-notes is indexed as human and outranks an agent record on the same words", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-notes-"));
  const body = (title) =>
    `---\ntitle: ${title}\n---\n\n# ${title}\n\nThe lighthouse keeper logs storms every night.\n`;
  for (const [dir, name] of [
    [STORE_DIR.memory, "agent.md"],
    [STORE_DIR.knowledge, "lesson.md"],
    [NOTES_DIR, "mine.md"],
  ]) {
    await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, dir, name), body(name));
  }
  const result = await reindexBrain({ root, indexPort, embedder: null });
  assert.equal(result.docs, 3);
  const found = await brainSearch({
    root,
    indexPort,
    query: "lighthouse keeper storms",
  });
  assert.equal(found.results[0].path, "notes/mine.md");
  assert.equal(found.results[0].file, `${NOTES_DIR}/mine.md`);
  assert.equal(found.results[0].origin, "human");
  assert.deepEqual(
    found.results.slice(1).map((hit) => hit.origin),
    ["agent", "agent"],
  );
});

test("a fact that disagrees with an owner's note waits in CONFLICTS.md; the note is untouched", async () => {
  const { proposeMemory } = await import("@ocean/brain/memory/memory-write.js");
  const { readFile } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-notes-conflict-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await mkdir(path.join(root, NOTES_DIR), { recursive: true });
    const note = "I start work at 9.\n";
    await writeFile(path.join(root, NOTES_DIR, "hours.md"), note);
    for (const bad of [
      "02-personal/x.md",
      `${NOTES_DIR}/../x.md`,
      `${NOTES_DIR}/none.md`,
    ])
      await assert.rejects(
        proposeMemory({ content: "x", origin: "inferred", contradicts: bad }),
        MemoryContractError,
      );
    const result = await proposeMemory({
      content: "He starts work at 10.",
      origin: "inferred",
      reason: "said so in a session",
      contradicts: `${NOTES_DIR}/hours.md`,
    });
    assert.equal(result.conflict, "02-personal/CONFLICTS.md");
    const conflicts = await readFile(
      path.join(root, "02-personal/CONFLICTS.md"),
      "utf8",
    );
    assert.match(conflicts, /^## \d{4}-\d{2}-\d{2} — 07-notes\/hours\.md$/m);
    assert.match(conflicts, /He starts work at 10\./);
    assert.ok(conflicts.includes(result.candidate));
    assert.match(
      await readFile(path.join(root, result.candidate), "utf8"),
      /^contradicts: "07-notes\/hours\.md"$/m,
    );
    assert.equal(
      await readFile(path.join(root, NOTES_DIR, "hours.md"), "utf8"),
      note,
    );
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});
