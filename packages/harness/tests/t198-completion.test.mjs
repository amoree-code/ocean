import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyIntent } from "../dist/application/context/intent-router.js";
import { projectConfirmationQuestion } from "../dist/application/context/project-resolution.js";
import { runOperation } from "../dist/application/operations/record-operations.js";
import { rankTaskCandidates } from "../dist/application/operations/task-linker.js";
import {
  createGrant,
  guardedRunOperation,
} from "../dist/application/operations/write-guard.js";
import { PERSONAL_DIR, PROJECTS_DIR } from "../dist/paths.js";

const BUDGET = {
  maxFiles: 10,
  maxBytes: 50_000,
  maxChars: 5_000,
  maxOperationCost: 5,
};

test("unbound and ambiguous project resolution each produce one focused confirmation question", () => {
  assert.match(
    projectConfirmationQuestion({
      status: "unbound",
      cwd: "/tmp",
      gitRoot: null,
      confidence: "none",
    }),
    /which Ocean project/i,
  );
  assert.match(
    projectConfirmationQuestion({
      status: "ambiguous",
      cwd: "/tmp",
      candidates: [],
      confidence: "low",
    }),
    /specify the project name or binding path/i,
  );
  assert.equal(
    projectConfirmationQuestion({
      status: "bound",
      projectId: "ocean",
      name: "Ocean",
      path: "/tmp/ocean",
      matchedOn: "ocean-root",
      confidence: "high",
    }),
    null,
  );
});

test("ocean operate routes deterministic natural-language reads through the Ocean operation layer", () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ocean-t198-cli-")),
  );
  fs.mkdirSync(path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-198"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-198", "task.md"),
    "---\nid: T-198\ntitle: Test task\nstate: active\nproject: ocean\ngoal: test\npriority: level_2\nupdated_at: 2026-09-16\n---\n",
  );
  const result = spawnSync(
    process.execPath,
    [path.resolve("dist/main.js"), "operate", "show", "T-198"],
    { cwd: root, env: { ...process.env, OCEAN_ROOT: root }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.classification.intent, "task-lookup");
  assert.equal(output.operation, "task.get");
  assert.equal(output.ok, true);
  assert.equal(output.records[0].provenance, "task");
});

test("ocean operate routes durable capture to the guarded path and refuses without approval", () => {
  const result = spawnSync(
    process.execPath,
    ["dist/main.js", "operate", "save", "this"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.operation, "memory.write");
  assert.equal(output.ok, false);
  assert.match(output.reason, /no explicit approval/i);
});

test("metadata-first task linking ranks explicit relationships before project, state, keywords, and recency", () => {
  const ranked = rankTaskCandidates(
    [
      {
        id: "T-2",
        projectId: "other",
        state: "active",
        updatedAt: "2026-09-16",
        keywords: ["ocean"],
        relationships: [],
      },
      {
        id: "T-1",
        projectId: "ocean",
        state: "active",
        updatedAt: "2026-09-16",
        keywords: ["ocean"],
        relationships: ["T-99"],
      },
    ],
    {
      projectId: "ocean",
      state: "active",
      keywords: ["ocean"],
      relationshipIds: ["T-99"],
    },
  );
  assert.equal(ranked[0].id, "T-1");
  assert.match(ranked[0].reasons.join(","), /explicit relationship match/);
});

test("corrections are additive evidence and never overwrite the original record", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-correction-"));
  await mkdir(path.join(root, PERSONAL_DIR), { recursive: true });
  const original = path.join(root, PERSONAL_DIR, "original.md");
  await writeFile(original, "---\nname: original\n---\noriginal evidence\n");
  const target = path.join(root, PERSONAL_DIR, "correction.md");
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    const scope = {
      action: "memory.write",
      target,
      identifier: "correction",
      projectId: "ocean",
    };
    const grant = createGrant("session-correction", scope);
    const result = await guardedRunOperation(
      {
        sessionId: "session-correction",
        classification: classifyIntent("remember this"),
        scope,
        budget: BUDGET,
        grant,
      },
      (approval) =>
        runOperation("memory.write", classifyIntent("remember this"), BUDGET, {
          cwd: root,
          slug: "correction",
          content: "corrected evidence",
          correctionOf: "original",
          provenance: "fact",
          approval,
        }),
    );
    assert.equal(result.decision.allowed, true);
    assert.equal(result.result.ok, true);
    assert.match(await readFile(target, "utf8"), /correction_of: original/);
    assert.equal(
      await readFile(original, "utf8"),
      "---\nname: original\n---\noriginal evidence\n",
    );
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});

test("task linking matches the workspace project's id, and other projects as different", () => {
  const candidate = (projectId) => ({
    id: "T-1",
    projectId,
    state: "active",
    updatedAt: "2026-09-16",
    keywords: [],
    relationships: [],
  });
  const reasons = (candidateId, requestId) =>
    rankTaskCandidates([candidate(candidateId)], { projectId: requestId })[0]
      .reasons;
  assert.ok(reasons("ocean", "ocean").includes("project match"));
  assert.ok(!reasons("legacy", "ocean").includes("project match"));
  assert.ok(reasons("acme", "acme").includes("project match"));
  assert.ok(!reasons("ocean-language", "ocean").includes("project match"));
});
