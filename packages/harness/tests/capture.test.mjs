import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  INBOX_DIR,
  KNOWLEDGE_DIR,
  PERSONAL_DIR,
  PROJECTS_DIR,
} from "../dist/paths.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-capture-cli-"));
  await mkdir(path.join(root, INBOX_DIR), { recursive: true });
  await mkdir(path.join(root, PERSONAL_DIR), { recursive: true });
  await mkdir(path.join(root, KNOWLEDGE_DIR, "results"), {
    recursive: true,
  });
  await mkdir(path.join(root, PROJECTS_DIR), { recursive: true });
  await writeFile(path.join(root, INBOX_DIR, "INBOX.md"), "# inbox\n");
  await writeFile(path.join(root, PERSONAL_DIR, "MEMORY.md"), "# Memory\n");
  await writeFile(path.join(root, PERSONAL_DIR, "goals.md"), "# Goals\n");
  await writeFile(
    path.join(root, KNOWLEDGE_DIR, "KNOWLEDGE.md"),
    "# Knowledge\n",
  );
  await writeFile(path.join(root, PROJECTS_DIR, "backlog.md"), "# Tasks\n");
  return root;
}

function cli(root, ...args) {
  const result = spawnSync(
    process.execPath,
    [path.resolve("dist/main.js"), ...args],
    {
      env: { ...process.env, OCEAN_ROOT: root },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("manual capture renders, promotes to knowledge, and updates its index", async () => {
  const root = await fixture();
  const item = cli(root, "capture", "add", "SMOKE_CAPTURE_CLI_IDEA");
  assert.match(
    await readFile(path.join(root, INBOX_DIR, "INBOX.md"), "utf8"),
    /SMOKE_CAPTURE_CLI_IDEA/,
  );
  cli(root, "capture", "promote", String(item.captureId), "knowledge/results");
  const records = (
    await readdir(path.join(root, KNOWLEDGE_DIR, "results"))
  ).filter((file) => file.endsWith(".md"));
  assert.equal(records.length, 1);
  assert.match(
    await readFile(path.join(root, KNOWLEDGE_DIR, "KNOWLEDGE.md"), "utf8"),
    new RegExp(records[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.deepEqual(cli(root, "capture", "list"), []);
});

test("discard removes a candidate from the inbox view without deleting its source session", async () => {
  const root = await fixture();
  const item = cli(root, "capture", "add", "SMOKE_CAPTURE_DISCARD_IDEA");
  cli(root, "capture", "discard", String(item.captureId));
  assert.doesNotMatch(
    await readFile(path.join(root, INBOX_DIR, "INBOX.md"), "utf8"),
    /SMOKE_CAPTURE_DISCARD_IDEA/,
  );
  assert.equal(cli(root, "capture", "list", "discarded").length, 1);
});
