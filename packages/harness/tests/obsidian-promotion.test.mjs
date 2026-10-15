import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listInboxCandidates,
  promoteInboxNote,
} from "../dist/application/obsidian/inbox-promotion.js";

test("plans and explicitly applies safe Obsidian inbox promotion", async () => {
  const vaultPath = await mkdtemp(
    path.join(os.tmpdir(), "ocean-obsidian-promotion-"),
  );
  await mkdir(path.join(vaultPath, "00-Inbox"), { recursive: true });
  await writeFile(
    path.join(vaultPath, "00-Inbox", "idea.md"),
    "---\ntype: knowledge\ndomain: education\n---\nIELTS\n",
  );
  const connection = { enabled: true, mode: "read-write", vaultPath };
  const [candidate] = await listInboxCandidates(connection);
  assert.equal(candidate.suggestedRoot, "02-Areas/Education");
  const plan = await promoteInboxNote(
    connection,
    candidate.path,
    candidate.suggestedRoot,
  );
  assert.equal(plan.applied, false);
  await assert.rejects(
    readFile(path.join(vaultPath, "02-Areas", "Education", "idea.md")),
  );
  const applied = await promoteInboxNote(
    connection,
    candidate.path,
    candidate.suggestedRoot,
    true,
  );
  assert.equal(applied.applied, true);
  assert.equal(
    await readFile(
      path.join(vaultPath, "02-Areas", "Education", "idea.md"),
      "utf8",
    ),
    "---\ntype: knowledge\ndomain: education\n---\nIELTS\n",
  );
});
