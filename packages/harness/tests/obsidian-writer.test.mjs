import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeObsidianNote } from "../dist/application/obsidian/vault-writer.js";

const digest = (content) => createHash("sha256").update(content).digest("hex");

test("writes Obsidian notes atomically and records stale-hash conflicts without overwriting", async () => {
  const vaultPath = await mkdtemp(
    path.join(os.tmpdir(), "ocean-obsidian-writer-"),
  );
  const conflictsDirectory = await mkdtemp(
    path.join(os.tmpdir(), "ocean-obsidian-conflicts-"),
  );
  const connection = { enabled: true, mode: "read-write", vaultPath };
  const planned = await writeObsidianNote(
    connection,
    "01-Projects/Ocean.md",
    "first",
    null,
  );
  assert.equal(planned.applied, false);
  const applied = await writeObsidianNote(
    connection,
    "01-Projects/Ocean.md",
    "first",
    null,
    true,
  );
  assert.equal(applied.applied, true);
  const conflict = await writeObsidianNote(
    connection,
    "01-Projects/Ocean.md",
    "second",
    digest("stale"),
    true,
    conflictsDirectory,
  );
  assert.equal(conflict.applied, false);
  assert.ok(conflict.conflict?.record);
  assert.equal(
    await readFile(path.join(vaultPath, "01-Projects/Ocean.md"), "utf8"),
    "first",
  );
  await access(conflict.conflict.record);
});

test("requires read-write mode for an applied Obsidian write", async () => {
  const vaultPath = await mkdtemp(
    path.join(os.tmpdir(), "ocean-obsidian-writer-readonly-"),
  );
  await assert.rejects(
    writeObsidianNote(
      { enabled: true, mode: "read-only", vaultPath },
      "note.md",
      "content",
      null,
      true,
    ),
    /read-only/,
  );
});
