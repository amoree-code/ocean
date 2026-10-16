import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  KNOWLEDGE_DIR,
  PERSONAL_DIR,
  PROJECTS_DIR,
  SYSTEM_DIR,
} from "@ocean/core/shared/paths.js";

test("doctor reports missing roots and broken active links without mutating", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-doctor-"));
  await mkdir(path.join(root, PERSONAL_DIR), { recursive: true });
  await mkdir(path.join(root, KNOWLEDGE_DIR), { recursive: true });
  await mkdir(path.join(root, PROJECTS_DIR, "ocean"), { recursive: true });
  await mkdir(path.join(root, SYSTEM_DIR), { recursive: true });
  await writeFile(
    path.join(root, PERSONAL_DIR, "MEMORY.md"),
    "# Memory\n\n[missing](nope.md)\n",
  );
  await writeFile(
    path.join(root, KNOWLEDGE_DIR, "KNOWLEDGE.md"),
    "# Knowledge\n",
  );
  const before = await readFile(
    path.join(root, PERSONAL_DIR, "MEMORY.md"),
    "utf8",
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
  const report = JSON.parse(result.stdout);
  assert.ok(report.findings.some((finding) => finding.code === "BROKEN_LINK"));
  assert.equal(
    await readFile(path.join(root, PERSONAL_DIR, "MEMORY.md"), "utf8"),
    before,
  );
});

test("doctor skips links in generated session summaries and installed skill docs, not in authored files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-doctor-links-"));
  for (const dir of [PERSONAL_DIR, KNOWLEDGE_DIR, PROJECTS_DIR, SYSTEM_DIR])
    await mkdir(path.join(root, dir), { recursive: true });
  const broken = "[gone](nope.md)\n";
  const put = async (file, text = broken) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  };
  await put(path.join(PERSONAL_DIR, "MEMORY.md"));
  await put(path.join(SYSTEM_DIR, "sessions", "summaries", "s.md"));
  await put(path.join(SYSTEM_DIR, "skills", "vendored", "README.md"));
  await put(path.join(SYSTEM_DIR, "docs", "mine.md"));
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
  const flagged = JSON.parse(result.stdout)
    .findings.filter((finding) => finding.code === "BROKEN_LINK")
    .map((finding) => finding.path.split(path.sep).join("/"))
    .sort();
  assert.deepEqual(flagged, [
    `${PERSONAL_DIR}/MEMORY.md`,
    `${SYSTEM_DIR}/docs/mine.md`,
  ]);
});

test("policy doctor reads policy references written as `ocean policy` only", async () => {
  const { CHARTER_DIR, POLICIES_DIR } = await import(
    "@ocean/core/shared/paths.js"
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-policy-doctor-"));
  await mkdir(path.join(root, POLICIES_DIR), { recursive: true });
  await writeFile(path.join(root, POLICIES_DIR, "task.md"), "# task\n");
  await writeFile(
    path.join(root, CHARTER_DIR, "core.md"),
    [
      "Load `ocean policy task` when starting work.",
      "Load `legacy policy task` too (not a reference).",
      "Load `ocean policy list` to see them all.",
      "Load `ocean policy missing-one` and `legacy policy missing-two`.",
    ].join("\n"),
  );
  const result = spawnSync(
    process.execPath,
    [path.resolve("dist/main.js"), "policy", "doctor"],
    { encoding: "utf8", env: { ...process.env, OCEAN_ROOT: root } },
  );
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.missing.sort(), ["missing-one"]);
  assert.equal(report.ok, false);
});
