import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CHARTER_DIR, POLICIES_DIR } from "../dist/paths.js";

// One doctor run costs ~10s, and the runner gives each test file 30s, so this lives in its
// own file and runs the doctor exactly once.
test("doctor GOVERNANCE_DRIFT reads policy references written as `ocean policy`", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-doctor-drift-"));
  await mkdir(path.join(root, POLICIES_DIR), { recursive: true });
  await writeFile(path.join(root, POLICIES_DIR, "task.md"), "# task\n");
  await writeFile(
    path.join(root, CHARTER_DIR, "core.md"),
    [
      "Present: `ocean policy task`.",
      "Missing: `ocean policy gone-new`.",
      "Not a reference any more: `legacy policy gone-old`.",
    ].join("\n"),
  );
  const result = spawnSync(
    process.execPath,
    [path.resolve("dist/main.js"), "doctor", "--json"],
    {
      env: {
        ...process.env,
        OCEAN_ROOT: root,
        OCEAN_SKIP_DEPENDENCY_AUDIT: "1",
      },
      encoding: "utf8",
    },
  );
  const drift = JSON.parse(result.stdout).findings.filter(
    (finding) => finding.code === "GOVERNANCE_DRIFT",
  );
  assert.equal(drift.length, 1);
  assert.match(drift[0].message, /gone-new/);
  assert.doesNotMatch(drift[0].message, /gone-old/);
  assert.doesNotMatch(drift[0].message, /\btask\b/);
});
