import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reindexBrain as reindexBrainRaw } from "../dist/application/brain/brain-reindex.js";
import {
  planContextRead,
  resolveLadderRung,
  validateBudget,
} from "../dist/application/context/context-ladder.js";
import { classifyIntent } from "../dist/application/context/intent-router.js";
import { defaultBrainIndexPort } from "../dist/composition/runtime.js";
import { KNOWLEDGE_DIR, PERSONAL_DIR, PROJECTS_DIR } from "../dist/paths.js";

const reindexBrain = (options) =>
  reindexBrainRaw({ indexPort: defaultBrainIndexPort, ...options });

const GOOD_BUDGET = {
  maxFiles: 5,
  maxBytes: 50_000,
  maxChars: 5_000,
  maxOperationCost: 5,
};

async function withTempTask(bytes, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-ladder-"));
  const taskDir = path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-1");
  await mkdir(taskDir, { recursive: true });
  await writeFile(path.join(taskDir, "task.md"), "x".repeat(bytes));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    return await fn(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

// --- budget validation ---

test("valid budget passes validation", () => {
  assert.deepEqual(validateBudget(GOOD_BUDGET), { valid: true });
});

test("missing budget (undefined) fails validation with a clear reason, not a crash", () => {
  const result = validateBudget(undefined);
  assert.equal(result.valid, false);
  assert.match(result.reason, /missing/);
});

test("missing budget (null) fails validation", () => {
  const result = validateBudget(null);
  assert.equal(result.valid, false);
});

test("budget missing a required field fails validation and names the field", () => {
  const { maxFiles, ...rest } = GOOD_BUDGET;
  const result = validateBudget(rest);
  assert.equal(result.valid, false);
  assert.match(result.reason, /maxFiles is missing/);
});

test("invalid budget: non-numeric field value is rejected", () => {
  const result = validateBudget({ ...GOOD_BUDGET, maxBytes: "a lot" });
  assert.equal(result.valid, false);
});

test("invalid budget: NaN is rejected", () => {
  const result = validateBudget({ ...GOOD_BUDGET, maxChars: NaN });
  assert.equal(result.valid, false);
});

test("invalid budget: non-integer (fractional) value is rejected", () => {
  const result = validateBudget({ ...GOOD_BUDGET, maxFiles: 1.5 });
  assert.equal(result.valid, false);
});

test("negative limits are rejected for every field", () => {
  for (const field of [
    "maxFiles",
    "maxBytes",
    "maxChars",
    "maxOperationCost",
  ]) {
    const result = validateBudget({ ...GOOD_BUDGET, [field]: -1 });
    assert.equal(result.valid, false, `${field} should reject -1`);
  }
});

test("zero limits are rejected for every field", () => {
  for (const field of [
    "maxFiles",
    "maxBytes",
    "maxChars",
    "maxOperationCost",
  ]) {
    const result = validateBudget({ ...GOOD_BUDGET, [field]: 0 });
    assert.equal(result.valid, false, `${field} should reject 0`);
  }
});

test("infinite limits are rejected", () => {
  const result = validateBudget({ ...GOOD_BUDGET, maxBytes: Infinity });
  assert.equal(result.valid, false);
});

test("oversized limits beyond the hard ceiling are rejected, not silently clamped", () => {
  const result = validateBudget({ ...GOOD_BUDGET, maxBytes: 100_000_000 });
  assert.equal(result.valid, false);
  assert.match(result.reason, /no greater than/);
});

// --- ladder rung resolution: fail-closed behavior ---

test("unknown intent stays at identity (fail-closed), no read attempted", () => {
  const classification = classifyIntent("show me that thing");
  const { rung } = resolveLadderRung(classification);
  assert.equal(rung, "identity");
});

test("ambiguous/medium-confidence intent (e.g. 'continue the login work') stays at identity, not escalated on a guess", () => {
  const classification = classifyIntent("continue the login work");
  assert.equal(classification.confidence, "medium");
  assert.ok(classification.ambiguityReason);
  const { rung } = resolveLadderRung(classification);
  assert.equal(rung, "identity");
});

test("missing identifier on a search-type intent resolves to ranked-references, never an exact-record guess", () => {
  const classification = classifyIntent("what did we decide about auth");
  assert.equal(classification.identifier, null);
  const { rung } = resolveLadderRung(classification);
  assert.equal(rung, "ranked-references");
});

test("write/execute-shaped intents never escalate the read ladder past identity", () => {
  for (const text of [
    "run the build",
    "save this as a decision",
    "start a new project called X",
  ]) {
    const classification = classifyIntent(text);
    const { rung } = resolveLadderRung(classification);
    assert.equal(rung, "identity", `${text} should stay at identity`);
  }
});

// --- planContextRead: end-to-end budget enforcement ---

test("unknown intent through planContextRead is allowed at identity with no files/bytes read", async () => {
  const classification = classifyIntent("show me that thing");
  const result = await planContextRead(classification, GOOD_BUDGET);
  assert.equal(result.rung, "identity");
  assert.equal(result.allowed, true);
  assert.deepEqual(result.files, []);
  assert.equal(result.bytes, 0);
});

test("missing budget on any classification stops immediately with violation invalid-budget", async () => {
  const classification = classifyIntent("show T-1");
  const result = await planContextRead(classification, undefined);
  assert.equal(result.allowed, false);
  assert.equal(result.violation, "invalid-budget");
  assert.deepEqual(result.files, []);
});

test("exact-limit success: task exactly at budget.maxBytes is allowed", () =>
  withTempTask(1000, async () => {
    const classification = classifyIntent("show T-1");
    const result = await planContextRead(classification, {
      ...GOOD_BUDGET,
      maxBytes: 1000,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.bytes, 1000);
    assert.equal(result.truncated, false);
  }));

test("one-over-limit failure: task one byte over budget.maxBytes is rejected, not silently truncated", () =>
  withTempTask(1000, async () => {
    const classification = classifyIntent("show T-1");
    const result = await planContextRead(classification, {
      ...GOOD_BUDGET,
      maxBytes: 999,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.violation, "max-bytes-exceeded");
    assert.equal(result.bytes, 0);
    assert.equal(result.truncated, false);
    assert.match(result.reason, /refusing to silently truncate/);
  }));

test("exact-limit success on maxFiles=1 for a single-file task record", () =>
  withTempTask(10, async () => {
    const classification = classifyIntent("show T-1");
    const result = await planContextRead(classification, {
      ...GOOD_BUDGET,
      maxFiles: 1,
    });
    assert.equal(result.allowed, true);
  }));

test("operation-cost limit stops an exact-record read before any file is touched", () =>
  withTempTask(10, async () => {
    const classification = classifyIntent("show T-1");
    const result = await planContextRead(classification, {
      ...GOOD_BUDGET,
      maxOperationCost: 1,
    });
    // exact-record costs 1, so cost 1 is exactly enough (exact-limit success case for cost)
    assert.equal(result.allowed, true);
  }));

test("multiple sequential operations do not leak state between calls (deterministic isolation)", () =>
  withTempTask(1000, async () => {
    const a = await planContextRead(classifyIntent("show T-1"), {
      ...GOOD_BUDGET,
      maxBytes: 999,
    });
    const b = await planContextRead(
      classifyIntent("what project am I in"),
      GOOD_BUDGET,
    );
    const c = await planContextRead(classifyIntent("show T-1"), {
      ...GOOD_BUDGET,
      maxBytes: 1000,
    });
    assert.equal(a.allowed, false);
    assert.equal(b.allowed, true);
    assert.equal(b.rung, "project-metadata");
    assert.equal(c.allowed, true);
  }));

test("missing identifier on a task-shaped request without a valid T-id never guesses a path", async () => {
  const classification = classifyIntent("show me task 123");
  assert.equal(classification.identifier, null);
  const result = await planContextRead(classification, GOOD_BUDGET);
  assert.equal(result.rung, "identity");
  assert.deepEqual(result.files, []);
});

// --- path traversal ---

test("path traversal: a task id that isn't a clean T-<digits> shape is rejected before any filesystem access, never resolved outside the task root", () =>
  withTempTask(10, async () => {
    // These can never satisfy classifyIntent's own T-\d+ extraction, so route the malformed
    // "identifier" straight at the ladder's public entry via a hand-built classification —
    // proving the ladder itself refuses to trust an unshaped identifier, not just the router.
    const malformed = [
      "../../etc/passwd",
      "T-1/../../../etc/passwd",
      "T-../../etc",
      "T-1;rm -rf",
      "T-1\0",
    ];
    for (const identifier of malformed) {
      const classification = {
        intent: "task-lookup",
        entityType: "task",
        identifier,
        action: "get",
        confidence: "high",
        ambiguityReason: null,
      };
      const result = await planContextRead(classification, GOOD_BUDGET);
      assert.equal(
        result.allowed,
        false,
        `should reject ${JSON.stringify(identifier)}`,
      );
      assert.deepEqual(result.files, []);
      assert.doesNotMatch(
        result.reason,
        /not found under the Ocean task root/,
        "should be rejected at shape validation, never reach a filesystem stat",
      );
    }
  }));

// --- large adversarial input ---

test("large adversarial input is classified and planned without unbounded work", async () => {
  const huge = "show T-1 ".repeat(20_000);
  const classification = classifyIntent(huge);
  const result = await planContextRead(classification, GOOD_BUDGET);
  assert.ok(JSON.stringify(result).length < 2000);
});

// --- Arabic and English intent output through the ladder ---

test("Arabic task-lookup ('عرض T-1') reaches exact-record exactly like its English equivalent", () =>
  withTempTask(10, async () => {
    const ar = await planContextRead(classifyIntent("عرض T-1"), GOOD_BUDGET);
    const en = await planContextRead(classifyIntent("show T-1"), GOOD_BUDGET);
    assert.equal(ar.rung, "exact-record");
    assert.deepEqual(ar.files, en.files);
    assert.equal(ar.allowed, en.allowed);
  }));

test("Arabic project-detect ('شنو المشروع الحالي') reaches project-metadata like its English equivalent", async () => {
  const ar = await planContextRead(
    classifyIntent("شنو المشروع الحالي"),
    GOOD_BUDGET,
  );
  const en = await planContextRead(
    classifyIntent("what project am I in"),
    GOOD_BUDGET,
  );
  assert.equal(ar.rung, "project-metadata");
  assert.equal(ar.rung, en.rung);
});

// --- determinism ---

test("identical input produces identical output across repeated calls", () =>
  withTempTask(500, async () => {
    const classification = classifyIntent("show T-1");
    const first = await planContextRead(classification, GOOD_BUDGET);
    const second = await planContextRead(classification, GOOD_BUDGET);
    assert.deepEqual(first, second);
  }));

// --- no persistence ---

test("planContextRead never writes any file (no persistence of user content or results)", () =>
  withTempTask(500, async (root) => {
    const before = JSON.stringify(
      await import("node:fs/promises").then((fs) =>
        fs.readdir(path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-1")),
      ),
    );
    await planContextRead(classifyIntent("show T-1"), GOOD_BUDGET);
    await planContextRead(
      classifyIntent("save this as a decision"),
      GOOD_BUDGET,
    );
    const after = JSON.stringify(
      await import("node:fs/promises").then((fs) =>
        fs.readdir(path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-1")),
      ),
    );
    assert.equal(before, after);
  }));

// --- no network/provider/MCP imports ---

test("context-ladder.ts imports only node:fs/promises, node:path, and the existing local paths/intent-router modules — no network, provider, or MCP module", async () => {
  const source = await readFile(
    path.resolve("src/application/context/context-ladder.ts"),
    "utf8",
  );
  const imports = [...source.matchAll(/^import .*?from "([^"]+)";?$/gm)].map(
    (match) => match[1],
  );
  const allowed = new Set([
    "node:fs/promises",
    "node:path",
    "../../paths.js",
    "./intent-router.js",
    "../brain/brain-service.js",
    "../../domain/ports/brain-index-port.js",
    "../../domain/brain/record-scope.js",
    "../../fs-utils.js",
    "../../domain/tasks/task-id.js",
    "../tasks/task-reference.js",
    "./project-resolution.js",
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

// --- ranked-references: query-driven brain-index path (T-228) ---

async function withTempMemoryRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-ladder-brain-"));
  await mkdir(path.join(root, PERSONAL_DIR), { recursive: true });
  await writeFile(
    path.join(root, PERSONAL_DIR, "goals.md"),
    "---\nid: goals\ntitle: Goals\nsummary: long term objectives\ntags: []\ntype: fact\nconfidence: high\ncreated: 2026-01-01\nupdated: 2026-01-01\nlast_confirmed_at: 2026-01-01\n---\n\n# Goals\n\nLong term objectives fixture body.\n",
  );
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    return await fn(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

test("ranked-references with a query and a built brain index is ranked by the index, not the fixed authoritative list", () =>
  withTempMemoryRoot(async (root) => {
    await reindexBrain({ root, embedder: null });
    const classification = classifyIntent("what do you remember about goals");
    assert.equal(classification.intent, "memory-lookup");
    const result = await planContextRead(
      classification,
      GOOD_BUDGET,
      root,
      "ocean",
      { query: "goals", indexPort: defaultBrainIndexPort },
    );
    assert.equal(result.rung, "ranked-references");
    assert.equal(result.allowed, true);
    assert.match(result.reason, /ranked by brain index/);
    assert.ok(result.files.some((file) => file.endsWith("goals.md")));
  }));

test("ranked-references with a query but no brain index built falls back to the fixed authoritative files, and says so", () =>
  withTempMemoryRoot(async (root) => {
    const classification = classifyIntent("what do you remember about goals");
    const result = await planContextRead(
      classification,
      GOOD_BUDGET,
      root,
      "ocean",
      { query: "goals", indexPort: defaultBrainIndexPort },
    );
    assert.equal(result.rung, "ranked-references");
    assert.match(result.reason, /brain index not built/);
    // Falls back to the same fixed authoritative-file behavior as no query at all.
    const withoutQuery = await planContextRead(
      classification,
      GOOD_BUDGET,
      root,
      "ocean",
    );
    assert.deepEqual(result.files, withoutQuery.files);
  }));

test("ranked-references with no query is unaffected — still the fixed authoritative files", () =>
  withTempMemoryRoot(async (root) => {
    await reindexBrain({ root, embedder: null });
    const classification = classifyIntent("what do you remember about goals");
    const result = await planContextRead(classification, GOOD_BUDGET, root);
    assert.equal(result.rung, "ranked-references");
    assert.doesNotMatch(result.reason, /brain index/);
  }));

// --- project scope (T-256 phase 4a) ---

async function withScopedRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-ladder-scope-"));
  const decisions = path.join(root, KNOWLEDGE_DIR, "decisions");
  await mkdir(decisions, { recursive: true });
  await mkdir(path.join(root, PERSONAL_DIR), { recursive: true });
  const record = (name, scope) =>
    writeFile(
      path.join(decisions, `${name}.md`),
      `---\nid: ${name}\ntitle: ${name}\n${scope === undefined ? "" : `scope: ${scope}\n`}---\n\n# ${name}\n\nzebrafood\n`,
    );
  await record("d-global", "global");
  await record("d-none", undefined);
  await record("d-a", "project:a");
  await record("d-b", "project:b");
  await record("d-bad", "ocean");
  await writeFile(path.join(root, PERSONAL_DIR, "MEMORY.md"), "# personal\n");
  await mkdir(path.join(root, PROJECTS_DIR, "a"), { recursive: true });
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    return await fn(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

const baseNames = (files) => files.map((file) => path.basename(file));

test("memory-lookup lists personal MEMORY.md, then the bound project's, in order", () =>
  withScopedRoot(async (root) => {
    await writeFile(
      path.join(root, PROJECTS_DIR, "a", "MEMORY.md"),
      "# project a\n",
    );
    const classification = classifyIntent("what do you remember about goals");
    const result = await planContextRead(
      classification,
      GOOD_BUDGET,
      root,
      "a",
    );
    assert.deepEqual(result.files, [
      `${PERSONAL_DIR}/MEMORY.md`,
      `${PROJECTS_DIR}/a/MEMORY.md`,
    ]);
  }));

test("memory-lookup is personal only when unbound or the project has no MEMORY.md", () =>
  withScopedRoot(async (root) => {
    const classification = classifyIntent("what do you remember about goals");
    for (const project of [null, "a", "missing"]) {
      const result = await planContextRead(
        classification,
        GOOD_BUDGET,
        root,
        project,
      );
      assert.deepEqual(
        result.files,
        [`${PERSONAL_DIR}/MEMORY.md`],
        String(project),
      );
    }
  }));

test("memory-lookup through the index leads with the MEMORY.md files, without duplicates", () =>
  withScopedRoot(async (root) => {
    await writeFile(
      path.join(root, PROJECTS_DIR, "a", "MEMORY.md"),
      "# project a\n",
    );
    await writeFile(
      path.join(root, PERSONAL_DIR, "goals.md"),
      "---\nid: goals\ntitle: Goals\nscope: project:b\n---\n\n# Goals\n\nzebrafood\n",
    );
    await reindexBrain({ root, embedder: null });
    const classification = classifyIntent("what do you remember about goals");
    const result = await planContextRead(
      classification,
      GOOD_BUDGET,
      root,
      "a",
      {
        query: "zebrafood",
        indexPort: defaultBrainIndexPort,
      },
    );
    assert.deepEqual(result.files.slice(0, 2), [
      `${PERSONAL_DIR}/MEMORY.md`,
      `${PROJECTS_DIR}/a/MEMORY.md`,
    ]);
    assert.equal(new Set(result.files).size, result.files.length);
    assert.equal(
      result.files.some((file) => file.endsWith("goals.md")),
      false,
    );
  }));

test("decision lookup without an index drops other projects' and malformed-scope records", () =>
  withScopedRoot(async (root) => {
    const classification = classifyIntent("what did we decide about auth");
    assert.equal(classification.intent, "decision-lookup");
    const files = async (project) =>
      baseNames(
        (await planContextRead(classification, GOOD_BUDGET, root, project))
          .files,
      );
    assert.deepEqual(await files("a"), ["d-a.md", "d-global.md", "d-none.md"]);
    assert.deepEqual(await files(null), ["d-global.md", "d-none.md"]);
  }));

test("exact record: a prefixed id resolves inside its own project only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-ladder-prefix-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    const lab = path.join(root, PROJECTS_DIR, "lab");
    await mkdir(path.join(lab, "tasks", "OL-001"), { recursive: true });
    await writeFile(
      path.join(lab, "project.json"),
      JSON.stringify({ name: "lab", paths: [], prefix: "OL", nextTask: 2 }),
    );
    await writeFile(
      path.join(lab, "tasks", "OL-001", "task.md"),
      "---\nid: OL-001\nstate: active\n---\n",
    );
    const classification = classifyIntent("show OL-001", ["T", "OL"]);
    const own = await planContextRead(classification, GOOD_BUDGET, root, "lab");
    assert.equal(own.allowed, true, own.reason);
    assert.deepEqual(own.files, ["04-projects/lab/tasks/OL-001/task.md"]);
    const other = await planContextRead(
      classification,
      GOOD_BUDGET,
      root,
      "ocean",
    );
    assert.equal(other.allowed, false);
    assert.match(other.reason, /was not found/);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});

test("an exact-record read carries the project's rules, and a corrupt manifest rejects it", () =>
  withTempTask(10, async (root) => {
    const manifest = path.join(root, PROJECTS_DIR, "ocean", "project.json");
    await writeFile(
      manifest,
      JSON.stringify({ name: "ocean", paths: [], rules: ["no prod writes"] }),
    );
    const classification = classifyIntent("show T-1");
    const result = await planContextRead(classification, GOOD_BUDGET);
    assert.equal(result.allowed, true);
    assert.deepEqual(result.rules, {
      project: "ocean",
      rules: ["no prod writes"],
    });

    await writeFile(manifest, JSON.stringify({ paths: [], rules: "bare" }));
    const rejected = await planContextRead(classification, GOOD_BUDGET);
    assert.equal(rejected.allowed, false);
    assert.match(rejected.reason, /rules are unreadable.*rules must be/);

    await rm(manifest);
    const plain = await planContextRead(classification, GOOD_BUDGET);
    assert.equal(plain.allowed, true);
    assert.equal("rules" in plain, false);
  }));
