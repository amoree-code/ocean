import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncObsidianVault } from "../dist/application/obsidian/vault-sync.js";

test("syncs Obsidian hashes and reports additions, changes, and removals without copying note content", async () => {
  const vaultPath = await mkdtemp(
    path.join(os.tmpdir(), "ocean-obsidian-sync-"),
  );
  const stateFile = path.join(
    await mkdtemp(path.join(os.tmpdir(), "ocean-obsidian-state-")),
    "sync-state.json",
  );
  await mkdir(path.join(vaultPath, ".obsidian"));
  await writeFile(
    path.join(vaultPath, "one.md"),
    "---\ntype: note\n---\nOne\n",
  );

  const first = await syncObsidianVault(
    { enabled: true, mode: "read-only", vaultPath },
    stateFile,
  );
  assert.deepEqual(first.added, ["one.md"]);
  assert.deepEqual(first.changed, []);
  assert.deepEqual(first.removed, []);

  await writeFile(
    path.join(vaultPath, "one.md"),
    "---\ntype: note\n---\nUpdated\n",
  );
  await writeFile(
    path.join(vaultPath, "two.md"),
    "---\ntype: note\n---\nTwo\n",
  );
  const second = await syncObsidianVault(
    { enabled: true, mode: "read-only", vaultPath },
    stateFile,
  );
  assert.deepEqual(second.added, ["two.md"]);
  assert.deepEqual(second.changed, ["one.md"]);

  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(state.notes["one.md"].content, undefined);
  assert.equal(state.vaultPath, vaultPath);
});
