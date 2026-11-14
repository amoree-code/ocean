import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  INBOX_DIR,
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

test("doctor warns on stray project-root files and missing standard folders", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-doctor-layout-"));
  for (const dir of [PERSONAL_DIR, KNOWLEDGE_DIR, SYSTEM_DIR])
    await mkdir(path.join(root, dir), { recursive: true });
  const project = path.join(root, PROJECTS_DIR, "acme");
  await mkdir(path.join(project, "tasks"), { recursive: true });
  await writeFile(
    path.join(project, "project.json"),
    `${JSON.stringify({ id: "acme", name: "acme", paths: ["~/acme"], created: "2026-10-26T00:00:00.000Z", autoRegistered: true })}\n`,
  );
  await writeFile(path.join(project, "MEMORY.md"), "# acme — memory\n");
  await writeFile(path.join(project, "api.md"), "# API\n");
  await writeFile(path.join(project, ".DS_Store"), "");
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
  const findings = JSON.parse(result.stdout).findings;
  const stray = findings.find((f) => f.code === "PROJECT_LAYOUT_STRAY");
  assert.match(stray.message, /api\.md/);
  assert.doesNotMatch(stray.message, /DS_Store|MEMORY\.md|tasks/);
  const missing = findings.find((f) => f.code === "PROJECT_LAYOUT_MISSING");
  assert.match(missing.message, /memory, docs/);
  assert.equal(missing.fixable, true);
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
  // Soft-deleted memory keeps the links it had (T-313).
  await put(path.join(SYSTEM_DIR, "state", "memory", "trash", "x", "old.md"));
  // A candidate quotes another tool's memory, links relative to where it came from.
  await put(path.join(INBOX_DIR, "candidates", "2026-11-06", "c.md"));
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

test("doctor reports a project left flat or uncategorized, and one id in two category folders (T-311)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-doctor-category-"));
  for (const dir of [PERSONAL_DIR, KNOWLEDGE_DIR, SYSTEM_DIR])
    await mkdir(path.join(root, dir), { recursive: true });
  const place = async (relative, id) => {
    const dir = path.join(root, PROJECTS_DIR, relative);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "project.json"),
      `${JSON.stringify({ id, name: id, paths: [] })}\n`,
    );
  };
  await place("flat-one", "flat-one");
  await place("uncategorized/fresh", "fresh");
  await place("company/filed", "filed");
  await place("company/twin", "twin");
  await place("personal/twin", "twin");
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
  const findings = JSON.parse(result.stdout).findings;
  const of = (code) => findings.filter((f) => f.code === code);
  assert.deepEqual(
    of("PROJECT_FLAT").map((f) => f.path),
    [`${PROJECTS_DIR}/flat-one`],
  );
  assert.match(
    of("PROJECT_FLAT")[0].message,
    /ocean project move flat-one <category>/,
  );
  assert.deepEqual(
    of("PROJECT_UNCATEGORIZED").map((f) => f.path),
    [`${PROJECTS_DIR}/uncategorized/fresh`],
  );
  assert.deepEqual(
    of("PROJECT_DUPLICATE_ID").map((f) => [f.severity, f.path]),
    [["FAIL", `${PROJECTS_DIR}/personal/twin/project.json`]],
  );
  // A filed project is not reported by the category checks.
  for (const code of [
    "PROJECT_FLAT",
    "PROJECT_UNCATEGORIZED",
    "PROJECT_DUPLICATE_ID",
  ])
    assert.equal(
      of(code).some((f) => f.path.includes("filed")),
      false,
      code,
    );
});

test("doctor warns when a client still runs a server older than the installed release (T-313)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-doctor-stale-"));
  for (const dir of [PERSONAL_DIR, KNOWLEDGE_DIR, PROJECTS_DIR, SYSTEM_DIR])
    await mkdir(path.join(root, dir), { recursive: true });
  const installed = JSON.parse(
    await readFile(path.resolve("package.json"), "utf8"),
  ).version;
  const ledger = path.join(root, SYSTEM_DIR, "state", "mcp", "calls.jsonl");
  await mkdir(path.dirname(ledger), { recursive: true });
  const now = Date.now();
  const at = (minutes) => new Date(now - minutes * 60_000).toISOString();
  await writeFile(
    ledger,
    `${[
      {
        ts: at(30),
        client: "claude-desktop",
        tool: "ocean_status",
        ok: true,
        version: "0.0.1",
      },
      {
        ts: at(10),
        client: "codex",
        tool: "brain_search",
        ok: true,
        version: installed,
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n")}\n`,
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
  const stale = JSON.parse(result.stdout).findings.filter(
    (finding) => finding.code === "RUNNING_STALE",
  );
  assert.equal(stale.length, 1, JSON.stringify(stale));
  assert.match(stale[0].message, /claude-desktop last reached Ocean 0\.0\.1/);
  assert.match(stale[0].message, /restart claude-desktop/);
});
