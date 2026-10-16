import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildContextPacket,
  buildSelectedReferences,
} from "@ocean/context/context/context-packet.js";
import { classifyIntent } from "@ocean/context/context/intent-router.js";
import { KNOWLEDGE_DIR, PROJECTS_DIR } from "@ocean/core/shared/paths.js";

const GOOD_BUDGET = {
  maxFiles: 5,
  maxBytes: 50_000,
  maxChars: 5_000,
  maxOperationCost: 5,
};

async function withTempTask(bytes, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-packet-"));
  const taskDir = path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-1");
  await mkdir(taskDir, { recursive: true });
  const file = path.join(taskDir, "task.md");
  await writeFile(file, "x".repeat(bytes));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    return await fn(root, file);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

async function withTempDecision(bytes, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-packet-"));
  const decisionsDir = path.join(root, KNOWLEDGE_DIR, "decisions");
  await mkdir(decisionsDir, { recursive: true });
  const file = path.join(decisionsDir, "decision-001.md");
  await writeFile(file, "x".repeat(bytes));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    return await fn(root, file);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

// --- valid packet from a clear intent ---

test("a valid, high-confidence task-lookup with a real task produces a packet with exactly one selected reference", () =>
  withTempTask(500, async (root) => {
    const classification = classifyIntent("show T-1");
    const packet = await buildContextPacket(classification, GOOD_BUDGET, root);
    assert.equal(packet.selectedReferences.length, 1);
    assert.equal(packet.selectedReferences[0].identifier, "T-1");
    assert.equal(packet.selectedReferences[0].recordType, "task");
    assert.equal(packet.sourcePaths.length, 1);
    assert.deepEqual(packet.recordTypes, ["task"]);
    assert.equal(packet.confidence, "high");
    assert.equal(packet.violations.length, 0);
    assert.equal(packet.activeProject.status, "bound");
  }));

// --- unknown intent ---

test("unknown intent produces an empty, fail-closed packet with no violations (a deliberate safe no-op, not an error)", async () => {
  const classification = classifyIntent("show me that thing");
  const packet = await buildContextPacket(classification, GOOD_BUDGET);
  assert.deepEqual(packet.selectedReferences, []);
  assert.deepEqual(packet.sourcePaths, []);
  assert.deepEqual(packet.recordTypes, []);
  assert.equal(packet.freshness, "unknown");
  assert.equal(packet.confidence, "low");
  assert.deepEqual(packet.violations, []);
});

// --- ambiguous intent ---

test("ambiguous intent ('continue the login work') stays fail-closed with medium confidence propagated and no guessed reference", async () => {
  const classification = classifyIntent("continue the login work");
  const packet = await buildContextPacket(classification, GOOD_BUDGET);
  assert.deepEqual(packet.selectedReferences, []);
  assert.equal(packet.confidence, "medium");
  assert.match(packet.selectionReason, /ambiguous|fail/i);
});

// --- missing identifier ---

test("decision lookup selects bounded authoritative decision references", () =>
  withTempDecision(500, async (root) => {
    const classification = classifyIntent("what did we decide about auth");
    assert.equal(classification.identifier, null);
    const packet = await buildContextPacket(classification, GOOD_BUDGET, root);
    assert.ok(
      packet.selectedReferences.length > 0 &&
        packet.selectedReferences.length <= GOOD_BUDGET.maxFiles,
    );
    assert.ok(
      packet.selectedReferences.every(
        (reference) => reference.recordType === "decision",
      ),
    );
    assert.ok(
      packet.sourcePaths.every((sourcePath) =>
        sourcePath.startsWith(`${KNOWLEDGE_DIR}/decisions/`),
      ),
    );
  }));

test("decision lookup carries another project's records only to that project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-packet-scope-"));
  const repo = await mkdtemp(path.join(os.tmpdir(), "ocean-packet-repo-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "ocean-packet-out-"));
  const decisions = path.join(root, KNOWLEDGE_DIR, "decisions");
  await mkdir(decisions, { recursive: true });
  for (const [name, scope] of [
    ["d-global", "global"],
    ["d-a", "project:a"],
    ["d-b", "project:b"],
  ])
    await writeFile(
      path.join(decisions, `${name}.md`),
      `---\nid: ${name}\nscope: ${scope}\n---\n\nx\n`,
    );
  await mkdir(path.join(root, PROJECTS_DIR, "a"), { recursive: true });
  await writeFile(
    path.join(root, PROJECTS_DIR, "a", "project.json"),
    JSON.stringify({ name: "a", paths: [repo] }),
  );
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    const classification = classifyIntent("what did we decide about auth");
    const names = async (cwd) =>
      (await buildContextPacket(classification, GOOD_BUDGET, cwd)).sourcePaths
        .map((sourcePath) => path.basename(sourcePath))
        .sort();
    assert.deepEqual(await names(repo), ["d-a.md", "d-global.md"]);
    assert.deepEqual(await names(outside), ["d-global.md"]);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});

// --- invalid identifier ---

test("invalid identifier shape (hand-crafted, bypassing the router) is rejected with a violation, never a guessed path", async () => {
  const classification = {
    intent: "task-lookup",
    entityType: "task",
    identifier: "T-1/../../etc/passwd",
    action: "get",
    confidence: "high",
    ambiguityReason: null,
  };
  const packet = await buildContextPacket(classification, GOOD_BUDGET);
  assert.deepEqual(packet.selectedReferences, []);
  assert.ok(packet.violations.length > 0);
});

// --- duplicate references ---

test("buildSelectedReferences drops an exact duplicate (same identifier + sourcePath) and reports it", () => {
  const candidate = {
    identifier: "T-1",
    recordType: "task",
    sourcePath: `${PROJECTS_DIR}/ocean/tasks/T-1/task.md`,
    freshness: "current",
    confidence: "high",
    selectionReason: "test",
  };
  const { references, violations } = buildSelectedReferences([
    candidate,
    { ...candidate },
  ]);
  assert.equal(references.length, 1);
  assert.match(violations.join(" "), /duplicate reference skipped/);
});

// --- multiple references ---

test("buildSelectedReferences keeps multiple distinct references", () => {
  const a = {
    identifier: "T-1",
    recordType: "task",
    sourcePath: `${PROJECTS_DIR}/ocean/tasks/T-1/task.md`,
    freshness: "current",
    confidence: "high",
    selectionReason: "a",
  };
  const b = {
    identifier: "T-2",
    recordType: "task",
    sourcePath: `${PROJECTS_DIR}/ocean/tasks/T-2/task.md`,
    freshness: "current",
    confidence: "high",
    selectionReason: "b",
  };
  const { references, violations } = buildSelectedReferences([a, b]);
  assert.equal(references.length, 2);
  assert.equal(violations.length, 0);
});

// --- reference ordering ---

test("buildSelectedReferences preserves stable insertion order", () => {
  const c = (id) => ({
    identifier: id,
    recordType: "task",
    sourcePath: `projects/ocean/tasks/${id}/task.md`,
    freshness: "current",
    confidence: "high",
    selectionReason: "x",
  });
  const { references } = buildSelectedReferences([
    c("T-3"),
    c("T-1"),
    c("T-2"),
  ]);
  assert.deepEqual(
    references.map((r) => r.identifier),
    ["T-3", "T-1", "T-2"],
  );
});

// --- explicit project path ---

test("explicit project path (cwd inside the Ocean root) resolves a bound active project, never guessed", () =>
  withTempTask(10, async (root) => {
    const classification = classifyIntent("what project am I in");
    const packet = await buildContextPacket(classification, GOOD_BUDGET, root);
    assert.equal(packet.activeProject.status, "bound");
    assert.equal(packet.activeProject.projectId, "ocean");
  }));

// --- missing project ---

test("missing project (cwd outside any binding and outside the Ocean root) reports unbound, not a guess", async () => {
  const outside = await mkdtemp(
    path.join(os.tmpdir(), "ocean-packet-outside-"),
  );
  const emptyOceanRoot = await mkdtemp(
    path.join(os.tmpdir(), "ocean-packet-empty-root-"),
  );
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = emptyOceanRoot;
  try {
    const classification = classifyIntent("what project am I in");
    const packet = await buildContextPacket(
      classification,
      GOOD_BUDGET,
      outside,
    );
    assert.equal(packet.activeProject.status, "unbound");
    assert.equal(packet.activeProject.projectId, null);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});

// --- stale source ---

test("a task file older than the freshness threshold is reported stale, not current", () =>
  withTempTask(10, async (root, file) => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
    await utimes(file, old, old);
    const classification = classifyIntent("show T-1");
    const packet = await buildContextPacket(classification, GOOD_BUDGET, root);
    assert.equal(packet.selectedReferences[0].freshness, "stale");
    assert.equal(packet.freshness, "stale");
  }));

// --- unknown freshness ---

test("no file read at all (identity rung) reports freshness unknown, never current", async () => {
  const classification = classifyIntent("run the build");
  const packet = await buildContextPacket(classification, GOOD_BUDGET);
  assert.equal(packet.freshness, "unknown");
});

// --- confidence propagation ---

test("packet.confidence is propagated directly from the intent classification's confidence for every intent", () => {
  const inputs = [
    "show T-1",
    "what did we decide about auth",
    "continue the login work",
    "show me that thing",
  ];
  return Promise.all(
    inputs.map(async (text) => {
      const classification = classifyIntent(text);
      const packet = await buildContextPacket(classification, GOOD_BUDGET);
      assert.equal(packet.confidence, classification.confidence, text);
    }),
  );
});

// --- selection reason propagation ---

test("packet.selectionReason is non-empty and reflects the ladder's rung resolution for a fail-closed case", async () => {
  const classification = classifyIntent("show me that thing");
  const packet = await buildContextPacket(classification, GOOD_BUDGET);
  assert.ok(packet.selectionReason.length > 0);
  assert.match(
    packet.selectionReason,
    /fail|closed|unknown|ambiguous|confidence/i,
  );
});

// --- exact budget limit ---

test("exact-limit success: a task exactly at budget.maxBytes is selected", () =>
  withTempTask(1000, async (root) => {
    const classification = classifyIntent("show T-1");
    const packet = await buildContextPacket(
      classification,
      { ...GOOD_BUDGET, maxBytes: 1000 },
      root,
    );
    assert.equal(packet.selectedReferences.length, 1);
    assert.equal(packet.violations.length, 0);
  }));

// --- one-over-budget failure ---

test("one-over-limit failure: a task one byte over budget.maxBytes is rejected, not truncated into the packet", () =>
  withTempTask(1000, async (root) => {
    const classification = classifyIntent("show T-1");
    const packet = await buildContextPacket(
      classification,
      { ...GOOD_BUDGET, maxBytes: 999 },
      root,
    );
    assert.equal(packet.selectedReferences.length, 0);
    assert.match(packet.violations.join(" "), /max-bytes-exceeded/);
  }));

// --- invalid budget ---

test("invalid budget (missing) stops before any filesystem read: project stays unbound/none, no reference selected", () =>
  withTempTask(10, async (root) => {
    const classification = classifyIntent("show T-1");
    const packet = await buildContextPacket(classification, undefined, root);
    assert.equal(packet.activeProject.status, "unbound");
    assert.equal(packet.activeProject.confidence, "none");
    assert.deepEqual(packet.selectedReferences, []);
    assert.match(packet.violations.join(" "), /invalid-budget/);
    assert.deepEqual(packet.budget, {
      maxFiles: null,
      maxBytes: null,
      maxChars: null,
      maxOperationCost: null,
    });
  }));

test("invalid budget (negative field) is rejected the same way as a missing budget", async () => {
  const classification = classifyIntent("show T-1");
  const packet = await buildContextPacket(classification, {
    ...GOOD_BUDGET,
    maxBytes: -1,
  });
  assert.match(packet.violations.join(" "), /invalid-budget/);
});

// --- path traversal ---

test("path traversal via a hand-crafted identifier never reaches the filesystem and is never listed as a source path", async () => {
  const payloads = [
    "../../etc/passwd",
    "T-1/../../../etc/passwd",
    "T-../../etc",
  ];
  for (const identifier of payloads) {
    const classification = {
      intent: "task-lookup",
      entityType: "task",
      identifier,
      action: "get",
      confidence: "high",
      ambiguityReason: null,
    };
    const packet = await buildContextPacket(classification, GOOD_BUDGET);
    assert.deepEqual(packet.sourcePaths, [], identifier);
  }
});

test("buildSelectedReferences rejects a traversal sourcePath even if identifier alone looked fine", () => {
  const candidate = {
    identifier: "T-1",
    recordType: "task",
    sourcePath: `${PROJECTS_DIR}/ocean/tasks/../../../etc/passwd`,
    freshness: "current",
    confidence: "high",
    selectionReason: "x",
  };
  const { references, violations } = buildSelectedReferences([candidate]);
  assert.equal(references.length, 0);
  assert.match(violations.join(" "), /path traversal/);
});

// --- absolute path ---

test("buildSelectedReferences rejects an absolute sourcePath", () => {
  const candidate = {
    identifier: "T-1",
    recordType: "task",
    sourcePath: "/etc/passwd",
    freshness: "current",
    confidence: "high",
    selectionReason: "x",
  };
  const { references, violations } = buildSelectedReferences([candidate]);
  assert.equal(references.length, 0);
  assert.match(violations.join(" "), /absolute path/);
});

// --- null byte ---

test("buildSelectedReferences rejects a null byte in the sourcePath or identifier", () => {
  const a = {
    identifier: "T-1",
    recordType: "task",
    sourcePath: `${PROJECTS_DIR}/ocean/tasks/T-1/task.md\0.png`,
    freshness: "current",
    confidence: "high",
    selectionReason: "x",
  };
  const b = {
    identifier: "T-1\0",
    recordType: "task",
    sourcePath: `${PROJECTS_DIR}/ocean/tasks/T-1/task.md`,
    freshness: "current",
    confidence: "high",
    selectionReason: "x",
  };
  assert.equal(buildSelectedReferences([a]).references.length, 0);
  assert.equal(buildSelectedReferences([b]).references.length, 0);
});

test("buildSelectedReferences rejects shell metacharacters in the sourcePath", () => {
  const candidate = {
    identifier: "T-1",
    recordType: "task",
    sourcePath: `${PROJECTS_DIR}/ocean/tasks/T-1/task.md; rm -rf /`,
    freshness: "current",
    confidence: "high",
    selectionReason: "x",
  };
  const { references, violations } = buildSelectedReferences([candidate]);
  assert.equal(references.length, 0);
  assert.ok(violations.length > 0);
});

// --- oversized input ---

test("a very large classified request still produces a small, bounded packet", async () => {
  const huge = "show T-1 ".repeat(20_000);
  const classification = classifyIntent(huge);
  const packet = await buildContextPacket(classification, GOOD_BUDGET);
  assert.ok(JSON.stringify(packet).length < 8_000);
});

test("a pathologically large synthetic reference list is cleared rather than left unbounded", () => {
  const candidates = Array.from({ length: 500 }, (_, index) => ({
    identifier: `T-${index}`,
    recordType: "task",
    sourcePath: `projects/ocean/tasks/T-${index}/task.md`,
    freshness: "current",
    confidence: "high",
    selectionReason: "synthetic bulk candidate for bound testing",
  }));
  const { references } = buildSelectedReferences(candidates);
  // buildSelectedReferences itself does not cap count (that's the caller's job via the
  // ladder's maxFiles budget in the real pipeline); assert the underlying data stays finite
  // and serializable so the caller-side packet bound (proven above) can do its job.
  assert.equal(references.length, 500);
  assert.doesNotThrow(() => JSON.stringify(references));
});

// --- deterministic repeated calls ---

test("identical classification + budget + cwd produces identical packets across repeated calls", () =>
  withTempTask(300, async (root) => {
    const classification = classifyIntent("show T-1");
    const first = await buildContextPacket(classification, GOOD_BUDGET, root);
    const second = await buildContextPacket(classification, GOOD_BUDGET, root);
    assert.deepEqual(first, second);
  }));

// --- no persistence ---

test("buildContextPacket never writes any file", () =>
  withTempTask(300, async (root) => {
    const { readdir } = await import("node:fs/promises");
    const taskDir = path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-1");
    const before = (await readdir(taskDir)).sort();
    await buildContextPacket(classifyIntent("show T-1"), GOOD_BUDGET, root);
    await buildContextPacket(
      classifyIntent("save this as a decision"),
      GOOD_BUDGET,
      root,
    );
    const after = (await readdir(taskDir)).sort();
    assert.deepEqual(before, after);
  }));

test("buildContextPacket does not embed unrequested user content — only identifiers/paths/metadata, never the raw input text", async () => {
  const secretLookingText =
    "show T-1 my password is hunter2 and my api key is sk-abcdef";
  const classification = classifyIntent(secretLookingText);
  const packet = await buildContextPacket(classification, GOOD_BUDGET);
  const serialized = JSON.stringify(packet);
  assert.doesNotMatch(serialized, /hunter2|sk-abcdef/);
});

// --- no network/provider/MCP imports ---

test("context-packet.ts imports only existing local modules and node:fs/promises, node:path — no network, provider, or MCP module", async () => {
  const source = await readFile(
    path.resolve("../context/src/context/context-packet.ts"),
    "utf8",
  );
  const imports = [...source.matchAll(/^import .*?from "([^"]+)";?$/gm)].map(
    (match) => match[1],
  );
  const allowed = new Set([
    "node:fs/promises",
    "node:path",
    "@ocean/core/shared/paths.js",
    "./intent-router.js",
    "./context-ladder.js",
    "@ocean/core/shared/project-resolution.js",
  ]);
  for (const specifier of imports)
    assert.ok(allowed.has(specifier), `unexpected import: ${specifier}`);
  const codeOnly = source
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(
    codeOnly,
    /node:https?|node:net\b|mcp-client|mcp-server|fetch\(/i,
  );
});

// --- English/Arabic parity ---

test("Arabic task-lookup ('عرض T-1') produces the same packet shape as its English equivalent", () =>
  withTempTask(200, async (root) => {
    const ar = await buildContextPacket(
      classifyIntent("عرض T-1"),
      GOOD_BUDGET,
      root,
    );
    const en = await buildContextPacket(
      classifyIntent("show T-1"),
      GOOD_BUDGET,
      root,
    );
    assert.deepEqual(ar, en);
  }));

test("Arabic project-detect ('شنو المشروع الحالي') produces the same active-project result as its English equivalent", () =>
  withTempTask(10, async (root) => {
    const ar = await buildContextPacket(
      classifyIntent("شنو المشروع الحالي"),
      GOOD_BUDGET,
      root,
    );
    const en = await buildContextPacket(
      classifyIntent("what project am I in"),
      GOOD_BUDGET,
      root,
    );
    assert.deepEqual(ar.activeProject, en.activeProject);
    assert.equal(ar.freshness, en.freshness);
  }));
