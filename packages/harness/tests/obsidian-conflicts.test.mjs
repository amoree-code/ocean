import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendConflict,
  parseConflictSide,
  readConflictRecord,
  resolveConflict,
} from "../dist/application/obsidian/conflict-log.js";

test("a conflict side is vault or ocean, and nothing else", () => {
  assert.equal(parseConflictSide("vault"), "vault");
  assert.equal(parseConflictSide("ocean"), "ocean");
  assert.equal(parseConflictSide("legacy"), null);
  assert.equal(parseConflictSide("both"), null);
  assert.equal(parseConflictSide(undefined), null);
});

test("new conflict records are written with ocean keys only", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ocean-conflicts-"));
  const file = await appendConflict(
    {
      path: "01-Projects/x.md",
      baselineSha256: "base",
      vaultSha256: "vault",
      oceanSha256: "ocean",
      oceanContent: "from ocean",
    },
    directory,
  );
  const stored = JSON.parse(await readFile(file, "utf8"));
  assert.equal(stored.oceanSha256, "ocean");
  assert.equal(stored.oceanContent, "from ocean");
});

test("resolveConflict reads records stored before the rename as the ocean side", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ocean-conflicts-"));
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "old.json"),
    JSON.stringify({
      version: 1,
      id: "old",
      path: "p.md",
      baselineSha256: "base",
      vaultSha256: "base",
      oceanSha256: "changed",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  let applied;
  const result = await resolveConflict("old", "ocean", {
    directory,
    apply: async (record, keep) => {
      applied = { keep, ocean: record.oceanSha256 };
    },
  });
  assert.equal(result.keep, "ocean");
  assert.equal(result.status, "auto-resolved");
  assert.deepEqual(applied, { keep: "ocean", ocean: "changed" });
  await assert.rejects(
    resolveConflict("old", "nonsense", { directory }),
    /vault or ocean/,
  );
});
