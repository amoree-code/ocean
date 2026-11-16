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
