import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reindexBrain as reindexBrainRaw } from "../dist/application/brain/brain-reindex.js";
import { classifyIntent } from "../dist/application/context/intent-router.js";
import {
  bindProject,
  peekNextTaskId,
} from "../dist/application/context/project-resolution.js";
import {
  operationForIntent,
  validateTaskIdentifier,
  validateWriteTarget,
} from "../dist/application/operations/operation-contract.js";
import { runOperation } from "../dist/application/operations/record-operations.js";
import {
  createGrant,
  guardedRunOperation,
} from "../dist/application/operations/write-guard.js";
import { defaultBrainIndexPort } from "../dist/composition/runtime.js";
import {
  engineRoot,
  KNOWLEDGE_DIR,
  oceanRoot,
  PERSONAL_DIR,
  PROJECTS_DIR,
  REGISTRY_DIR,
} from "../dist/paths.js";

const reindexBrain = (options) =>
  reindexBrainRaw({ indexPort: defaultBrainIndexPort, ...options });

const BUDGET = {
  maxFiles: 10,
  maxBytes: 50_000,
  maxChars: 5_000,
  maxOperationCost: 5,
};

function taskDoc(id, state = "active", checked = true) {
  const item = checked ? '- "[x] done work"' : '- "[ ] unfinished work"';
  return `---\nkind: task\nid: ${id}\ntitle: Task ${id}\nstate: ${state}\nproject: ocean\ngoal: goal for ${id}\npriority: level_2\nupdated_at: 2026-09-16\n---\n\nchecklist:\n  ${item}\n\n## Objective\nbody of ${id}\n`;
}

function recordDoc(name, description) {
  return `---\nname: ${name}\ndescription: "${description}"\nmetadata:\n  type: note\n  status: current\n  confidence: high\n  updated: 2026-09-16\n---\n\nbody\n`;
}

async function withFixture(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-slice7-"));
  await mkdir(path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-1"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-1", "task.md"),
    taskDoc("T-1"),
  );
  await mkdir(path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-2"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-2", "task.md"),
    taskDoc("T-2"),
  );
  await mkdir(path.join(root, PERSONAL_DIR), { recursive: true });
  await writeFile(
    path.join(root, PERSONAL_DIR, "work-style.md"),
    recordDoc("development", "Technical defaults and tooling"),
  );
  await writeFile(
    path.join(root, PERSONAL_DIR, "goals.md"),
    recordDoc("goals", "Long term objectives"),
  );
  await mkdir(path.join(root, KNOWLEDGE_DIR, "decisions"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, KNOWLEDGE_DIR, "decisions", "adopt-ocean.md"),
    recordDoc("adopt-ocean", "Decision to adopt Ocean"),
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

const approval = (operation, target) => ({ approved: true, operation, target });

// ---------------------------------------------------------------- intent → operation map

test("every required intent maps to exactly one operation", () => {
  const cases = [
    ["show T-1", "task.get"],
    ["what do you remember about the client", "memory.search"],
    ["what knowledge do we have about deployments", "knowledge.search"],
    ["what is my work style", "memory.search"],
    ["what project am I in", "project.detect"],
    ["start a new project called demo", "project.create"],
    ["save this as a decision", "knowledge.write"],
    ["remember this", "memory.write"],
    ["what did we decide about auth", "knowledge.search"],
  ];
  for (const [text, expected] of cases) {
    assert.equal(
      operationForIntent(classifyIntent(text)).operation,
      expected,
      text,
    );
  }
});

test("task.create requires explicit title and approval, then creates the next bounded task", async () => {
  await withFixture(async (root) => {
    await bindProject("ocean", root);
    const classification = classifyIntent(
      "create a new task called Improve onboarding",
    );
    assert.equal(classification.intent, "task-create");
    assert.equal(operationForIntent(classification).operation, "task.create");
    const budget = BUDGET;
    const denied = await runOperation("task.create", classification, budget, {
      cwd: root,
    });
    assert.equal(denied.ok, false);
    const target = path.join(
      root,
      PROJECTS_DIR,
      "ocean",
      "tasks",
      await peekNextTaskId("ocean"),
      "task.md",
    );
    const scope = {
      action: "task.create",
      target,
      identifier: null,
      projectId: "ocean",
    };
    const sessionId = "task-create-session";
    const grant = createGrant(sessionId, scope);
    const { decision, result } = await guardedRunOperation(
      { sessionId, classification, scope, budget, grant },
      (approval) =>
        runOperation("task.create", classification, budget, {
          cwd: root,
          content: "Implement onboarding improvements",
          approval,
        }),
    );
    assert.equal(decision.allowed, true, decision.reason);
    assert.equal(result.ok, true, result.reason);
    assert.match(await readFile(target, "utf8"), /title: Improve onboarding/);
    assert.match(target, /T-003/);
    assert.match(
      await readFile(target, "utf8"),
      /^---\nid: T-003\n/,
      "the next id is zero padded",
    );
  });
});

test("task.create refuses an approval for an id another create already took, and consumes nothing", async () => {
  await withFixture(async (root) => {
    await bindProject("ocean", root);
    const classification = classifyIntent("create a new task called Race");
    const predicted = await peekNextTaskId("ocean");
    const stale = path.join(
      root,
      PROJECTS_DIR,
      "ocean",
      "tasks",
      "T-099",
      "task.md",
    );
    // An approval granted for an id that is no longer the next one.
    const result = await runOperation("task.create", classification, BUDGET, {
      cwd: root,
      approval: approval("task.create", stale),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, new RegExp(`the next id is now ${predicted}`));
    assert.match(result.reason, /request a new approval/);
    assert.equal(await peekNextTaskId("ocean"), predicted);
    await assert.rejects(readFile(stale, "utf8"));
  });
});

test("an execution intent maps to no record operation at all", () => {
  const mapped = operationForIntent(classifyIntent("run the build"));
  assert.equal(mapped.operation, null);
});

test("an operation that does not match the classified intent is refused, never coerced", () =>
  withFixture(async (root) => {
    const result = await runOperation(
      "memory.write",
      classifyIntent("show T-1"),
      BUDGET,
      {
        cwd: root,
        approval: approval("memory.write", "/x"),
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /does not match intent/);
  }));

// ---------------------------------------------------------------- task read operations

test("task.get returns one bounded record with selected fields only", () =>
  withFixture(async (root) => {
    const result = await runOperation(
      "task.get",
      classifyIntent("show T-1"),
      BUDGET,
      {
        cwd: root,
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.records.length, 1);
    const record = result.records[0];
    assert.equal(record.identifier, "T-1");
    assert.equal(record.recordType, "task");
    assert.equal(record.sourcePath, `${PROJECTS_DIR}/ocean/tasks/T-1/task.md`);
    assert.deepEqual(Object.keys(record.fields).sort(), [
      "goal",
      "id",
      "priority",
      "state",
      "title",
      "updated_at",
    ]);
    assert.ok(!("body" in record.fields));
    assert.equal(record.freshness, "current");
    assert.equal(record.confidence, "high");
    assert.ok(record.selectionReason.length > 0);
  }));

test("task.list returns every live task, stably ordered, never the archive directory", () =>
  withFixture(async (root) => {
    const result = await runOperation(
      "task.list",
      classifyIntent("continue"),
      BUDGET,
      {
        cwd: root,
      },
    );
    assert.equal(
      result.ok,
      false,
      "bare 'continue' is ambiguous and must fail closed",
    );
    const listable = {
      intent: "task-lookup",
      entityType: "task",
      identifier: null,
      action: "list",
      confidence: "high",
      ambiguityReason: null,
    };
    const listed = await runOperation("task.list", listable, BUDGET, {
      cwd: root,
    });
    assert.equal(listed.ok, true);
    assert.deepEqual(
      listed.records.map((record) => record.identifier),
      ["T-1", "T-2"],
    );
    assert.ok(
      listed.records.every((record) => !record.sourcePath.includes("archive")),
    );
  }));

test("task.list ordering is stable regardless of filesystem ordering", () =>
  withFixture(async (root) => {
    await mkdir(path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-10"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-10", "task.md"),
      taskDoc("T-10"),
    );
    const listable = {
      intent: "task-lookup",
      entityType: "task",
      identifier: null,
      action: "list",
      confidence: "high",
      ambiguityReason: null,
    };
    const first = await runOperation("task.list", listable, BUDGET, {
      cwd: root,
    });
    const second = await runOperation("task.list", listable, BUDGET, {
      cwd: root,
    });
    assert.deepEqual(
      first.records.map((r) => r.identifier),
      second.records.map((r) => r.identifier),
    );
  }));

test("task.get on a missing task reports not-found, never a guessed record", () =>
  withFixture(async (root) => {
    const result = await runOperation(
      "task.get",
      classifyIntent("show T-9999"),
      BUDGET,
      {
        cwd: root,
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /was not found/);
    assert.deepEqual(result.records, []);
  }));

test("task.get freshness reports stale for an old record", () =>
  withFixture(async (root) => {
    const file = path.join(
      root,
      PROJECTS_DIR,
      "ocean",
      "tasks",
      "T-1",
      "task.md",
    );
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await utimes(file, old, old);
    const result = await runOperation(
      "task.get",
      classifyIntent("show T-1"),
      BUDGET,
      {
        cwd: root,
      },
    );
    assert.equal(result.records[0].freshness, "stale");
  }));

// ---------------------------------------------------------------- identifier validation

test("valid and invalid task identifiers are separated deterministically", () => {
  assert.equal(validateTaskIdentifier("T-1").valid, true);
  assert.equal(validateTaskIdentifier("T-0001").valid, true);
  for (const bad of [
    "",
    "T1",
    "TOOLONGX-1",
    "t-1",
    "T-",
    "t-1x",
    "T-1/../etc",
    "T-1\0",
    null,
    undefined,
    12,
  ]) {
    assert.equal(validateTaskIdentifier(bad).valid, false, String(bad));
  }
});

test("a missing identifier never produces a task.get read", () =>
  withFixture(async (root) => {
    const classification = {
      intent: "task-lookup",
      entityType: "task",
      identifier: null,
      action: "get",
      confidence: "high",
      ambiguityReason: null,
    };
    const result = await runOperation("task.get", classification, BUDGET, {
      cwd: root,
    });
    // Refused at the intent-mapping gate: without an identifier the intent maps to
    // task.list, so an exact-record read is never reachable.
    assert.equal(result.ok, false);
    assert.match(result.reason, /does not match intent|identifier is missing/);
    assert.deepEqual(result.records, []);
  }));

// ---------------------------------------------------------------- memory / knowledge read

test("memory.search returns only personal/memory records — no tasks, no engine files", () =>
  withFixture(async (root) => {
    const result = await runOperation(
      "memory.search",
      classifyIntent("what do you remember about goals"),
      BUDGET,
      { cwd: root, query: "goals" },
    );
    assert.equal(result.ok, true);
    assert.ok(result.records.length >= 1);
    assert.ok(
      result.records.every((record) =>
        record.sourcePath.startsWith(`${PERSONAL_DIR}/`),
      ),
      JSON.stringify(result.records),
    );
    assert.ok(result.records.every((record) => record.recordType === "memory"));
  }));

test("knowledge.search returns only personal/knowledge records", () =>
  withFixture(async (root) => {
    const result = await runOperation(
      "knowledge.search",
      classifyIntent("what did we decide about ocean"),
      BUDGET,
      { cwd: root, query: "ocean" },
    );
    assert.equal(result.ok, true);
    assert.ok(
      result.records.every((record) =>
        record.sourcePath.startsWith(`${KNOWLEDGE_DIR}/`),
      ),
    );
  }));

test("search results carry freshness, confidence, and an explicit selection reason", () =>
  withFixture(async (root) => {
    const result = await runOperation(
      "memory.search",
      classifyIntent("what do you remember about goals"),
      BUDGET,
      { cwd: root, query: "goals" },
    );
    for (const record of result.records) {
      assert.ok(["current", "stale", "unknown"].includes(record.freshness));
      assert.equal(record.confidence, "high");
      assert.match(record.selectionReason, /goals|index entry/);
    }
  }));

test("search is deduplicated and capped by budget.maxFiles with an explicit truncation violation", () =>
  withFixture(async (root) => {
    for (let index = 0; index < 8; index += 1) {
      await writeFile(
        path.join(root, PERSONAL_DIR, `note-${index}.md`),
        recordDoc(`note-${index}`, "bulk note"),
      );
    }
    const result = await runOperation(
      "memory.search",
      classifyIntent("what do you remember"),
      { ...BUDGET, maxFiles: 3 },
      { cwd: root },
    );
    assert.equal(result.records.length, 3);
    assert.match(result.violations.join(" "), /truncated to maxFiles=3/);
  }));

// ---------------------------------------------------------------- project scope (T-256 4a)

async function withScopedRecords(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-slice7-scope-"));
  const repoA = await mkdtemp(path.join(os.tmpdir(), "ocean-slice7-repo-a-"));
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), "ocean-slice7-out-"));
  await mkdir(path.join(root, PROJECTS_DIR, "a"), { recursive: true });
  await writeFile(
    path.join(root, PROJECTS_DIR, "a", "project.json"),
    JSON.stringify({ name: "a", paths: [repoA] }),
  );
  const write = async (dir, name, scope) => {
    await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(
      path.join(root, dir, `${name}.md`),
      `---\nid: ${name}\ntitle: zebrafood ${name}\n${scope ? `scope: ${scope}\n` : ""}---\n\nzebrafood\n`,
    );
  };
  for (const dir of [PERSONAL_DIR, `${KNOWLEDGE_DIR}/decisions`]) {
    const tag = dir === PERSONAL_DIR ? "m" : "k";
    await write(dir, `${tag}-global`, "global");
    await write(dir, `${tag}-none`, "");
    await write(dir, `${tag}-a`, "project:a");
    await write(dir, `${tag}-b`, "project:b");
    await write(dir, `${tag}-bad`, "ocean");
  }
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    return await fn({ root, repoA, elsewhere });
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

const recordNames = (result) =>
  result.records
    .map((record) => path.basename(record.sourcePath, ".md"))
    .sort();

for (const [operation, tag, text] of [
  ["memory.search", "m", "what do you remember about zebrafood"],
  ["knowledge.search", "k", "what knowledge do we have about zebrafood"],
]) {
  for (const indexed of [true, false]) {
    test(`${operation} (${indexed ? "index" : "substring"}) hides other projects' and malformed-scope records`, () =>
      withScopedRecords(async ({ root, repoA, elsewhere }) => {
        if (indexed) await reindexBrain({ root, embedder: null });
        const search = (cwd) =>
          runOperation(operation, classifyIntent(text), BUDGET, {
            cwd,
            query: "zebrafood",
            indexPort: indexed ? defaultBrainIndexPort : undefined,
          });
        const bound = await search(repoA);
        assert.deepEqual(recordNames(bound), [
          `${tag}-a`,
          `${tag}-global`,
          `${tag}-none`,
        ]);
        assert.deepEqual(recordNames(await search(elsewhere)), [
          `${tag}-global`,
          `${tag}-none`,
        ]);
      }));
  }
}

test("memory.search reports an unreadable registry and falls back to global records", () =>
  withScopedRecords(async ({ root, repoA }) => {
    // A corrupt legacy registry is what makes resolveProject throw (a bad manifest only hides itself).
    await mkdir(path.join(root, REGISTRY_DIR), { recursive: true });
    await writeFile(
      path.join(root, REGISTRY_DIR, "project-bindings.json"),
      "{ not json",
    );
    const result = await runOperation(
      "memory.search",
      classifyIntent("what do you remember about zebrafood"),
      BUDGET,
      { cwd: repoA, query: "zebrafood" },
    );
    assert.deepEqual(recordNames(result), ["m-global", "m-none"]);
    assert.match(
      result.violations.join(" "),
      /project unresolved: .*global records only/,
    );
  }));

// ---------------------------------------------------------------- write gating

test("a write is refused without an explicit approval", () =>
  withFixture(async (root) => {
    const result = await runOperation(
      "memory.write",
      classifyIntent("remember this"),
      BUDGET,
      {
        cwd: root,
        slug: "new-note",
        content: "hello",
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /no explicit approval/);
  }));

test("a write is refused when the approval names a different operation", () =>
  withFixture(async (root) => {
    const target = path.join(root, PERSONAL_DIR, "new-note.md");
    const result = await runOperation(
      "memory.write",
      classifyIntent("remember this"),
      BUDGET,
      {
        cwd: root,
        slug: "new-note",
        content: "hello",
        approval: approval("knowledge.write", target),
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /approval was granted for/);
  }));

test("a write is refused when the approval names a different target path", () =>
  withFixture(async (root) => {
    const wrong = path.join(root, PERSONAL_DIR, "other.md");
    const result = await runOperation(
      "memory.write",
      classifyIntent("remember this"),
      BUDGET,
      {
        cwd: root,
        slug: "new-note",
        content: "hello",
        approval: approval("memory.write", wrong),
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /does not match the resolved destination/);
  }));

test("medium-confidence and low-confidence intents never execute a write", () =>
  withFixture(async (root) => {
    const target = path.join(root, PERSONAL_DIR, "new-note.md");
    for (const confidence of ["medium", "low"]) {
      const classification = {
        intent: "remember",
        entityType: "memory",
        identifier: null,
        action: "remember",
        confidence,
        ambiguityReason: null,
      };
      const result = await runOperation(
        "memory.write",
        classification,
        BUDGET,
        {
          cwd: root,
          slug: "new-note",
          content: "x",
          approval: approval("memory.write", target),
        },
      );
      assert.equal(result.ok, false, confidence);
      assert.match(result.reason, /only 'high' may write/);
    }
  }));

test("unknown and ambiguous intents fail closed for both reads and writes", () =>
  withFixture(async (root) => {
    const unknown = classifyIntent("show me that thing");
    const read = await runOperation("task.get", unknown, BUDGET, {
      cwd: root,
    });
    assert.equal(read.ok, false);
    const ambiguous = classifyIntent("continue the login work");
    const write = await runOperation("task.update", ambiguous, BUDGET, {
      cwd: root,
      patch: { state: "done" },
      approval: approval("task.update", "/x"),
    });
    assert.equal(write.ok, false);
  }));

test("an invalid budget blocks every operation, read or write", () =>
  withFixture(async (root) => {
    const read = await runOperation(
      "task.get",
      classifyIntent("show T-1"),
      { ...BUDGET, maxBytes: -1 },
      { cwd: root },
    );
    assert.equal(read.ok, false);
    assert.match(read.reason, /invalid-budget/);
    const missing = await runOperation(
      "task.get",
      classifyIntent("show T-1"),
      undefined,
      {
        cwd: root,
      },
    );
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /invalid-budget/);
  }));

// ---------------------------------------------------------------- writes that succeed

test("memory.write creates a private record under personal/memory and reports the written path", () =>
  withFixture(async (root) => {
    const target = path.join(root, PERSONAL_DIR, "new-note.md");
    const result = await runOperation(
      "memory.write",
      classifyIntent("remember this"),
      BUDGET,
      {
        cwd: root,
        slug: "new-note",
        content: "an explicit fact",
        approval: approval("memory.write", target),
      },
    );
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.written.sourcePath, `${PERSONAL_DIR}/new-note.md`);
    const written = await readFile(target, "utf8");
    assert.match(written, /id: new-note/);
    assert.match(written, /an explicit fact/);
  }));

test("knowledge.write stores a decision under the requested knowledge kind", () =>
  withFixture(async (root) => {
    const target = path.join(root, KNOWLEDGE_DIR, "decisions", "use-sqlite.md");
    const result = await runOperation(
      "knowledge.write",
      classifyIntent("save this as a decision"),
      BUDGET,
      {
        cwd: root,
        slug: "use-sqlite",
        kind: "decisions",
        content: "we chose sqlite",
        approval: approval("knowledge.write", target),
      },
    );
    assert.equal(result.ok, true, result.reason);
    assert.equal(
      result.written.sourcePath,
      `${KNOWLEDGE_DIR}/decisions/use-sqlite.md`,
    );
    assert.match(await readFile(target, "utf8"), /type: decision/);
  }));

test("knowledge.write refuses a knowledge kind outside the allow-list", () =>
  withFixture(async (root) => {
    const target = path.join(root, KNOWLEDGE_DIR, "secrets", "x.md");
    const result = await runOperation(
      "knowledge.write",
      classifyIntent("save this as a decision"),
      BUDGET,
      {
        cwd: root,
        slug: "x",
        kind: "secrets",
        content: "y",
        approval: approval("knowledge.write", target),
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /not an allowed knowledge kind/);
  }));

test("a record write never overwrites an existing record", () =>
  withFixture(async (root) => {
    const target = path.join(root, PERSONAL_DIR, "goals.md");
    const result = await runOperation(
      "memory.write",
      classifyIntent("remember this"),
      BUDGET,
      {
        cwd: root,
        slug: "goals",
        content: "replacement",
        approval: approval("memory.write", target),
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /refusing to overwrite/);
    assert.match(await readFile(target, "utf8"), /Long term objectives/);
  }));

test("task.update patches only allow-listed frontmatter fields, atomically", () =>
  withFixture(async (root) => {
    const target = path.join(
      root,
      PROJECTS_DIR,
      "ocean",
      "tasks",
      "T-1",
      "task.md",
    );
    const classification = {
      intent: "task-lookup",
      entityType: "task",
      identifier: "T-1",
      action: "update",
      confidence: "high",
      ambiguityReason: null,
    };
    const result = await runOperation("task.update", classification, BUDGET, {
      cwd: root,
      patch: { state: "blocked" },
      approval: approval("task.update", target),
    });
    assert.equal(result.ok, true, result.reason);
    assert.match(await readFile(target, "utf8"), /^state: blocked$/m);
    const rejected = await runOperation("task.update", classification, BUDGET, {
      cwd: root,
      patch: { secret: "x" },
      approval: approval("task.update", target),
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /not an updatable task field/);
  }));

test("task.complete reuses the governed completion path and refuses unchecked work", () =>
  withFixture(async (root) => {
    const dir = path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-3");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "task.md"), taskDoc("T-3", "active", false));
    const classification = {
      intent: "task-lookup",
      entityType: "task",
      identifier: "T-3",
      action: "complete",
      confidence: "high",
      ambiguityReason: null,
    };
    const target = path.join(dir, "task.md");
    const result = await runOperation("task.complete", classification, BUDGET, {
      cwd: root,
      approval: approval("task.complete", target),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /unchecked work/);
  }));

test("task.complete succeeds for a fully checked task", () =>
  withFixture(async (root) => {
    const target = path.join(
      root,
      PROJECTS_DIR,
      "ocean",
      "tasks",
      "T-2",
      "task.md",
    );
    const classification = {
      intent: "task-lookup",
      entityType: "task",
      identifier: "T-2",
      action: "complete",
      confidence: "high",
      ambiguityReason: null,
    };
    const result = await runOperation("task.complete", classification, BUDGET, {
      cwd: root,
      approval: approval("task.complete", target),
    });
    assert.equal(result.ok, true, result.reason);
  }));

// ---------------------------------------------------------------- project operations

test("project.detect reports the bound project without guessing", () =>
  withFixture(async (root) => {
    const result = await runOperation(
      "project.detect",
      classifyIntent("what project am I in"),
      BUDGET,
      { cwd: root },
    );
    assert.equal(result.ok, true);
    assert.equal(result.records[0].identifier, "ocean");
    assert.equal(result.records[0].fields.status, "bound");
  }));

test("project.detect reports unbound for a directory outside any binding", () =>
  withFixture(async () => {
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "ocean-slice7-outside-"),
    );
    const result = await runOperation(
      "project.detect",
      classifyIntent("what project am I in"),
      BUDGET,
      { cwd: outside },
    );
    assert.equal(result.records[0].identifier, "unbound");
  }));

test("project.create requires an explicit absolute path and an approval", () =>
  withFixture(async (root) => {
    const classification = classifyIntent("start a new project called demo");
    const target = path.join(root, PROJECTS_DIR, "demo");
    const noPath = await runOperation(
      "project.create",
      classification,
      BUDGET,
      {
        cwd: root,
        approval: approval("project.create", target),
      },
    );
    assert.equal(noPath.ok, false);
    assert.match(noPath.reason, /absolute project path is required/);
    const created = await runOperation(
      "project.create",
      classification,
      BUDGET,
      {
        cwd: root,
        projectPath: path.join(root, "workspace-demo"),
        approval: approval("project.create", target),
      },
    );
    assert.equal(created.ok, true, created.reason);
    assert.ok((await stat(target)).isDirectory());
  }));

test("project.update confirms the active project binding only", () =>
  withFixture(async (root) => {
    const classification = {
      intent: "project-create",
      entityType: "project",
      identifier: "ocean",
      action: "create",
      confidence: "high",
      ambiguityReason: null,
    };
    const result = await runOperation(
      "project.update",
      classification,
      BUDGET,
      {
        cwd: root,
        projectPath: root,
        approval: approval(
          "project.update",
          path.join(root, PROJECTS_DIR, "ocean"),
        ),
      },
    );
    assert.equal(
      result.ok,
      false,
      "project.update must not accept a project-create classification",
    );
  }));

// ---------------------------------------------------------------- scope and path safety

test("a cross-project request is refused explicitly", () =>
  withFixture(async (root) => {
    const result = await runOperation(
      "task.get",
      classifyIntent("show T-1"),
      BUDGET,
      {
        cwd: root,
        requestedProject: "other-project",
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /cross-project request refused/);
  }));

test("a request naming the workspace project by its id is not a cross-project request", () =>
  withFixture(async (root) => {
    for (const requestedProject of ["ocean"]) {
      const result = await runOperation(
        "task.get",
        classifyIntent("show T-1"),
        BUDGET,
        { cwd: root, requestedProject },
      );
      assert.doesNotMatch(
        result.reason ?? "",
        /cross-project/,
        requestedProject,
      );
    }
  }));

test("private Ocean content is never written inside the public engine package", () => {
  // The engine lives inside the real workspace root (~/ocean/kernel/packages/harness), not inside
  // the test sandbox, so validate against that root. Nothing is written.
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = path.resolve(engineRoot(), "..", "..", "..");
  try {
    const engineRelative = path
      .relative(oceanRoot(), engineRoot())
      .split(path.sep);
    const rejected = validateWriteTarget(...engineRelative, "src", "leak.md");
    assert.equal(rejected.valid, false);
    assert.match(rejected.reason, /public engine package/);
  } finally {
    process.env.OCEAN_ROOT = previous;
  }
});

test("write targets that escape the Ocean root are refused", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-escape-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    const rejected = validateWriteTarget("..", "..", "etc", "passwd");
    assert.equal(rejected.valid, false);
    assert.match(rejected.reason, /escapes the Ocean root/);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});

test("path traversal, absolute paths, null bytes, and shell syntax are all refused in write slugs", () =>
  withFixture(async (root) => {
    const target = path.join(root, PERSONAL_DIR, "x.md");
    for (const slug of [
      "../../etc/passwd",
      "/etc/passwd",
      "note\0",
      "note; rm -rf /",
      "note$(whoami)",
      "a/b",
    ]) {
      const result = await runOperation(
        "memory.write",
        classifyIntent("remember this"),
        BUDGET,
        {
          cwd: root,
          slug,
          content: "x",
          approval: approval("memory.write", target),
        },
      );
      assert.equal(result.ok, false, slug);
      assert.match(result.reason, /write refused/);
    }
  }));

test("traversal in a task identifier never resolves outside the task root", () =>
  withFixture(async (root) => {
    const classification = {
      intent: "task-lookup",
      entityType: "task",
      identifier: "T-1/../../../etc",
      action: "get",
      confidence: "high",
      ambiguityReason: null,
    };
    const result = await runOperation("task.get", classification, BUDGET, {
      cwd: root,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.records, []);
  }));

// ---------------------------------------------------------------- budget boundaries

test("exact-limit success: a task exactly at budget.maxBytes is returned", () =>
  withFixture(async (root) => {
    const file = path.join(
      root,
      PROJECTS_DIR,
      "ocean",
      "tasks",
      "T-1",
      "task.md",
    );
    const size = (await stat(file)).size;
    const result = await runOperation(
      "task.get",
      classifyIntent("show T-1"),
      { ...BUDGET, maxBytes: size },
      { cwd: root },
    );
    assert.equal(result.ok, true, result.reason);
  }));

test("one-over-limit failure: a task one byte over budget.maxBytes is refused, not truncated", () =>
  withFixture(async (root) => {
    const file = path.join(
      root,
      PROJECTS_DIR,
      "ocean",
      "tasks",
      "T-1",
      "task.md",
    );
    const size = (await stat(file)).size;
    const result = await runOperation(
      "task.get",
      classifyIntent("show T-1"),
      { ...BUDGET, maxBytes: size - 1 },
      { cwd: root },
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /refusing to silently truncate/);
    assert.deepEqual(result.records, []);
  }));

test("oversized content is refused for a write rather than clipped", () =>
  withFixture(async (root) => {
    const target = path.join(root, PERSONAL_DIR, "big.md");
    const result = await runOperation(
      "memory.write",
      classifyIntent("remember this"),
      { ...BUDGET, maxBytes: 100 },
      {
        cwd: root,
        slug: "big",
        content: "x".repeat(500),
        approval: approval("memory.write", target),
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /maxBytes/);
  }));

test("an oversized query does not produce an unbounded result", () =>
  withFixture(async (root) => {
    const result = await runOperation(
      "memory.search",
      classifyIntent("what do you remember"),
      BUDGET,
      { cwd: root, query: "z".repeat(50_000) },
    );
    assert.equal(result.ok, true);
    assert.equal(result.records.length, 0);
    assert.ok(JSON.stringify(result).length < 2_000);
  }));

// ---------------------------------------------------------------- atomicity & persistence

test("a failed write leaves no partial content and no temp file behind", () =>
  withFixture(async (root) => {
    const directory = path.join(root, PERSONAL_DIR);
    const target = path.join(directory, "locked.md");
    await rm(directory, { recursive: true, force: true });
    await writeFile(directory, "not-a-directory");
    try {
      const result = await runOperation(
        "memory.write",
        classifyIntent("remember this"),
        BUDGET,
        {
          cwd: root,
          slug: "locked",
          content: "should not land",
          approval: approval("memory.write", target),
        },
      );
      assert.equal(result.ok, false);
      assert.match(result.reason, /write failed atomically/);
    } finally {
      await rm(directory, { force: true });
    }
    assert.equal((await stat(path.dirname(directory))).isDirectory(), true);
  }));

test("read operations never write anything to the record directories", () =>
  withFixture(async (root) => {
    const memoryDir = path.join(root, PERSONAL_DIR);
    const before = (await readdir(memoryDir)).sort();
    await runOperation(
      "memory.search",
      classifyIntent("what do you remember"),
      BUDGET,
      {
        cwd: root,
      },
    );
    await runOperation("task.get", classifyIntent("show T-1"), BUDGET, {
      cwd: root,
    });
    const after = (await readdir(memoryDir)).sort();
    assert.deepEqual(before, after);
  }));

// ---------------------------------------------------------------- determinism & parity

test("repeated identical operations return identical results", () =>
  withFixture(async (root) => {
    const first = await runOperation(
      "task.get",
      classifyIntent("show T-1"),
      BUDGET,
      {
        cwd: root,
      },
    );
    const second = await runOperation(
      "task.get",
      classifyIntent("show T-1"),
      BUDGET,
      {
        cwd: root,
      },
    );
    assert.deepEqual(first, second);
  }));

test("Arabic and English requests reach the same operation and the same records", () =>
  withFixture(async (root) => {
    const arabic = await runOperation(
      "task.get",
      classifyIntent("عرض T-1"),
      BUDGET,
      {
        cwd: root,
      },
    );
    const english = await runOperation(
      "task.get",
      classifyIntent("show T-1"),
      BUDGET,
      {
        cwd: root,
      },
    );
    assert.deepEqual(arabic, english);
    assert.equal(
      operationForIntent(classifyIntent("شنو المشروع الحالي")).operation,
      "project.detect",
    );
    assert.equal(
      operationForIntent(classifyIntent("احفظ هذا كقرار")).operation,
      "knowledge.write",
    );
  }));

// ---------------------------------------------------------------- brain-index ranked search (T-228)

test("memory.search is ranked by the brain index when one has been built, and says so", () =>
  withFixture(async (root) => {
    await reindexBrain({ root, embedder: null });
    const result = await runOperation(
      "memory.search",
      classifyIntent("what do you remember about goals"),
      BUDGET,
      { cwd: root, query: "goals", indexPort: defaultBrainIndexPort },
    );
    assert.equal(result.ok, true);
    assert.ok(result.records.length >= 1);
    assert.ok(
      result.records.every((record) =>
        record.selectionReason.includes("brain index"),
      ),
      JSON.stringify(result.records),
    );
    assert.ok(
      result.records.every((record) =>
        record.sourcePath.startsWith(`${PERSONAL_DIR}/`),
      ),
    );
  }));

test("memory.search without a built brain index falls back to substring matching, unaffected", () =>
  withFixture(async (root) => {
    const result = await runOperation(
      "memory.search",
      classifyIntent("what do you remember about goals"),
      BUDGET,
      { cwd: root, query: "goals" },
    );
    assert.equal(result.ok, true);
    assert.ok(
      result.records.every(
        (record) => !record.selectionReason.includes("brain index"),
      ),
    );
  }));

test("task.create in a project with a prefix issues PREFIX-nnn and advances its counter", async () => {
  await withFixture(async (root) => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "ocean-prefixed-repo-"));
    await bindProject("lab", repo);
    const first = await peekNextTaskId("lab");
    assert.equal(first, "LAB-001");
    const classification = classifyIntent("create a new task called First");
    const target = path.join(
      root,
      PROJECTS_DIR,
      "lab",
      "tasks",
      first,
      "task.md",
    );
    const result = await runOperation("task.create", classification, BUDGET, {
      cwd: repo,
      approval: approval("task.create", target),
    });
    assert.equal(result.ok, true, result.reason);
    assert.match(await readFile(target, "utf8"), /^---\nid: LAB-001\n/);
    assert.equal(await peekNextTaskId("lab"), "LAB-002");
    const manifest = JSON.parse(
      await readFile(
        path.join(root, PROJECTS_DIR, "lab", "project.json"),
        "utf8",
      ),
    );
    assert.equal(manifest.nextTask, 2);
    // The new task is readable by its prefixed id, and refused from another project.
    const get = await runOperation(
      "task.get",
      classifyIntent("show LAB-001", ["T", "LAB"]),
      BUDGET,
      { cwd: repo },
    );
    assert.equal(get.ok, true, get.reason);
    assert.equal(get.records[0].identifier, "LAB-001");
    const foreign = await runOperation(
      "task.get",
      classifyIntent("show LAB-001", ["T", "LAB"]),
      BUDGET,
      { cwd: root },
    );
    assert.equal(foreign.ok, false);
    assert.match(foreign.reason, /cross-project request refused/);
  });
});
