import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activityOf,
  overviewTable,
  writeRegistryBlock,
} from "@ocean/services/projects/projects-overview.js";

// T-317: the project registry is derived, not hand-kept.
const row = {
  id: "shop",
  path: "~/code/shop",
  git: {
    branch: "main",
    dirty: 2,
    lastCommit: "2026-11-01",
    remote: "github.com/x/shop",
  },
  activity: "active",
  openTasks: 1,
  nextAction: "SH-001: ship | the cart",
  lastSession: "2026-11-02",
};

test("activity comes from the last commit: active, warm, dormant, no git", () => {
  assert.equal(activityOf("2026-11-01", "2026-11-18"), "active");
  assert.equal(activityOf("2026-06-01", "2026-11-18"), "warm");
  assert.equal(activityOf("2025-01-01", "2026-11-18"), "dormant");
  assert.equal(activityOf(undefined, "2026-11-18"), "no git");
});

test("the table escapes pipes and marks empty cells", () => {
  const table = overviewTable([{ ...row, git: undefined, lastSession: "" }]);
  assert.match(
    table,
    /\| \*\*shop\*\* \| active \| — \| — \| — \| — \| 1 \| SH-001: ship \\\| the cart \|/,
  );
});

test("status --write keeps the owner's registry text and replaces only its own block", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-projects-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await mkdir(path.join(root, "04-projects"), { recursive: true });
    const file = path.join(root, "04-projects", "registry.md");
    await writeFile(file, "# Project registry\n\nHand-kept stack notes.\n");
    await writeRegistryBlock([row], "2026-11-18");
    await writeRegistryBlock([{ ...row, openTasks: 3 }], "2026-11-19");
    const text = await readFile(file, "utf8");
    assert.match(text, /^# Project registry\n\nHand-kept stack notes\.\n/);
    assert.equal(text.match(/ocean:project-status:begin/g)?.length, 1);
    assert.match(text, /Live \(generated 2026-11-19\)/);
    assert.match(text, /\| 3 \|/);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});
