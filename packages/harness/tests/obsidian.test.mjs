import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverObsidianVault } from "../dist/application/obsidian/vault-discovery.js";

test("discovers an Obsidian vault read-only without indexing hidden metadata", async () => {
  const vaultPath = await mkdtemp(
    path.join(os.tmpdir(), "ocean-obsidian-vault-"),
  );
  await mkdir(path.join(vaultPath, ".obsidian"));
  await writeFile(
    path.join(vaultPath, ".obsidian", "workspace.json"),
    "private UI state",
  );
  await writeFile(
    path.join(vaultPath, "good.md"),
    "---\ntype: knowledge\nstatus: current\n---\n# Good\n",
  );
  await mkdir(path.join(vaultPath, "nested"));
  await writeFile(
    path.join(vaultPath, "nested", "needs-review.md"),
    "# Missing properties\n",
  );

  const result = await discoverObsidianVault({
    enabled: true,
    mode: "read-only",
    vaultPath,
  });
  assert.equal(result.noteCount, 2);
  assert.equal(
    result.notes.some((note) => note.path === ".obsidian/workspace.json"),
    false,
  );
  assert.equal(
    result.notes.find((note) => note.path === "good.md")?.issues.length,
    0,
  );
  assert.deepEqual(result.issues, [
    "nested/needs-review.md: missing YAML properties",
    "nested/needs-review.md: missing property: type",
  ]);
  assert.match(result.notes[0].sha256, /^[a-f0-9]{64}$/);
});
