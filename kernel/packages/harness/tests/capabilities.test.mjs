import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readWorkspaceFile } from "../dist/infrastructure/filesystem/workspace-capability.js";

test("reference capability reads only allowed files and returns a post-condition hash", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-capability-"));
  await mkdir(path.join(root, "allowed"));
  await writeFile(path.join(root, "allowed", "note.txt"), "hello");
  await writeFile(path.join(root, "secret.txt"), "secret");
  const result = await readWorkspaceFile(root, "allowed/note.txt", ["allowed"]);
  assert.equal(result.contract.operation, "read");
  assert.equal(result.bytes, 5);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(
    () => readWorkspaceFile(root, "secret.txt", ["allowed"]),
    /Capability denied/,
  );
  await assert.rejects(
    () => readWorkspaceFile(root, "allowed/note.txt", ["allowed"], 32_000, 0),
    /Capability timed out/,
  );
});
