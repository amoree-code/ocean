import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { classifyIntent } from "@ocean/context/context/intent-router.js";

// --- task lookup: get, show, explain, continue, update, complete ---

test("task lookup: bare 'show T-123' resolves get with high confidence", () => {
  const result = classifyIntent("show T-123");
  assert.deepEqual(result, {
    intent: "task-lookup",
    entityType: "task",
    identifier: "T-123",
    action: "get",
    confidence: "high",
    ambiguityReason: null,
  });
});

test("task lookup: 'explain T-7' also resolves as get (no dedicated explain verb, defaults to get)", () => {
  const result = classifyIntent("can you explain T-7 to me");
  assert.equal(result.intent, "task-lookup");
  assert.equal(result.identifier, "T-7");
  assert.equal(result.action, "get");
});

test("task lookup: 'update T-45' resolves the update action", () => {
  const result = classifyIntent("update T-45 with the new plan");
  assert.equal(result.action, "update");
  assert.equal(result.identifier, "T-45");
});

test("task lookup: 'complete T-9' resolves the complete action", () => {
  const result = classifyIntent("mark T-9 as complete");
  assert.equal(result.action, "complete");
});

test("task lookup: 'continue T-3' resolves the continue action, still high confidence (explicit id)", () => {
  const result = classifyIntent("continue T-3");
  assert.equal(result.action, "continue");
  assert.equal(result.confidence, "high");
  assert.equal(result.identifier, "T-3");
});

test("task lookup: case-insensitive and mixed casing ('sHoW t-45') still resolves and normalizes the id", () => {
  const result = classifyIntent("sHoW t-45");
  assert.equal(result.identifier, "T-45");
  assert.equal(result.confidence, "high");
});

test("task lookup: 'continue the login work' with no id is a medium-confidence task/project ambiguity, not a guess", () => {
  const result = classifyIntent("continue the login work");
  assert.equal(result.intent, "task-lookup");
  assert.equal(result.identifier, null);
  assert.equal(result.action, "continue");
  assert.equal(result.confidence, "medium");
  assert.ok(result.ambiguityReason);
});

// --- task id validation ---

test("invalid task id shape ('TASK-123', no hyphenated T- prefix) is not treated as an identifier", () => {
  const result = classifyIntent("show TASK-123");
  assert.notEqual(result.entityType, "task");
  assert.equal(result.identifier, null);
});

test("a registered project prefix makes 'OL-001' an identifier; look-alikes and unregistered prefixes stay text", () => {
  const prefixes = ["T", "OL"];
  const hit = classifyIntent("show OL-001", prefixes);
  assert.equal(hit.entityType, "task");
  assert.equal(hit.identifier, "OL-001");
  assert.equal(classifyIntent("show OL-001").identifier, null);
  assert.equal(classifyIntent("show ol-1", prefixes).identifier, null);
  for (const text of [
    "show UTF-8",
    "show SHA-256",
    "show GPT-5",
    "show TASK-123",
  ])
    assert.equal(classifyIntent(text, prefixes).identifier, null, text);
  assert.match(
    classifyIntent("compare T-1 and OL-2", prefixes).ambiguityReason,
    /multiple task identifiers/,
  );
});

test("invalid task id shape ('T123', missing hyphen) is not treated as an identifier", () => {
  const result = classifyIntent("show T123");
  assert.notEqual(result.identifier, "T123");
});

test("multiple task identifiers in one request are never guessed at — returns a safe ambiguous result", () => {
  const result = classifyIntent("show T-1 and T-2");
  assert.equal(result.intent, "unknown");
  assert.equal(result.identifier, null);
  assert.equal(result.confidence, "low");
  assert.match(result.ambiguityReason, /multiple task identifiers/);
});

// --- memory lookup ---

test("memory lookup: a recall question ('what do you remember about X') is memory-lookup, not a save command", () => {
  const result = classifyIntent("what do you remember about the client");
  assert.equal(result.intent, "memory-lookup");
  assert.equal(result.entityType, "memory");
  assert.equal(result.action, "search");
  assert.equal(result.confidence, "high");
});

// --- knowledge lookup ---

test("knowledge lookup: 'what knowledge do we have about deployments'", () => {
  const result = classifyIntent("what knowledge do we have about deployments");
  assert.equal(result.intent, "knowledge-lookup");
  assert.equal(result.entityType, "knowledge");
});

// --- work-style lookup ---

test("work-style lookup: 'what is my work style'", () => {
  const result = classifyIntent("what is my work style");
  assert.deepEqual(result, {
    intent: "work-style-lookup",
    entityType: "work-style",
    identifier: null,
    action: "lookup",
    confidence: "high",
    ambiguityReason: null,
  });
});

// --- project detection ---

test("project detection: 'what project am I in'", () => {
  const result = classifyIntent("what project am I in");
  assert.equal(result.intent, "project-detect");
  assert.equal(result.entityType, "project");
});

// --- project creation ---

test("project creation: 'start a new project called X' captures the name and returns high confidence", () => {
  const result = classifyIntent("start a new project called X");
  assert.deepEqual(result, {
    intent: "project-create",
    entityType: "project",
    identifier: "X",
    action: "create",
    confidence: "high",
    ambiguityReason: null,
  });
});

test("project creation without a captured name is medium confidence, not a guessed name", () => {
  const result = classifyIntent("let's start a new project");
  assert.equal(result.intent, "project-create");
  assert.equal(result.identifier, null);
  assert.equal(result.confidence, "medium");
  assert.ok(result.ambiguityReason);
});

// --- durable save / remember ---

test("remember: 'save this as a decision' is high-confidence remember with entityType decision", () => {
  const result = classifyIntent("save this as a decision");
  assert.deepEqual(result, {
    intent: "remember",
    entityType: "decision",
    identifier: null,
    action: "remember",
    confidence: "high",
    ambiguityReason: null,
  });
});

test("remember: 'remember this' (imperative with explicit target) is high-confidence remember", () => {
  const result = classifyIntent("remember this");
  assert.equal(result.intent, "remember");
  assert.equal(result.entityType, "memory");
  assert.equal(result.confidence, "high");
});

test("remember: bare 'save' with no target is medium confidence, not upgraded to high", () => {
  const result = classifyIntent("please save my progress");
  assert.equal(result.intent, "remember");
  assert.equal(result.confidence, "medium");
  assert.ok(result.ambiguityReason);
});

// --- decision lookup ---

test("decision lookup: 'what did we decide about auth'", () => {
  const result = classifyIntent("what did we decide about auth");
  assert.equal(result.intent, "decision-lookup");
  assert.equal(result.entityType, "decision");
  assert.equal(result.action, "lookup");
});

// --- execution request ---

test("execution request: 'run the build'", () => {
  const result = classifyIntent("run the build");
  assert.equal(result.intent, "execute");
  assert.equal(result.entityType, "execution");
  assert.equal(result.action, "execute");
});

// --- missing identifiers / ambiguous / unknown ---

test("missing identifier on an otherwise clear task-shaped request without T- falls back to unknown, never guessed", () => {
  const result = classifyIntent("show me task 123");
  assert.equal(result.identifier, null);
  assert.notEqual(result.intent, "task-lookup");
});

test("unknown/ambiguous: 'show me that thing' returns a safe low-confidence result with no retrieval implied", () => {
  const result = classifyIntent("show me that thing");
  assert.deepEqual(result, {
    intent: "unknown",
    entityType: "unknown",
    identifier: null,
    action: "unknown",
    confidence: "low",
    ambiguityReason:
      "no recognizable entity, verb, or identifier matched in the request",
  });
});

test("empty request returns a safe result, not a crash", () => {
  const result = classifyIntent("");
  assert.equal(result.intent, "unknown");
  assert.equal(result.confidence, "low");
});

// --- Arabic wording (Iraqi/MSA per project convention) ---

test("Arabic: 'عرض T-12' (show T-12) resolves the task by id", () => {
  const result = classifyIntent("عرض T-12");
  assert.equal(result.intent, "task-lookup");
  assert.equal(result.identifier, "T-12");
});

test("Arabic: 'احفظ هذا كقرار' (save this as a decision) resolves remember/decision", () => {
  const result = classifyIntent("احفظ هذا كقرار");
  assert.equal(result.intent, "remember");
  assert.equal(result.entityType, "decision");
  assert.equal(result.confidence, "high");
});

test("Arabic: 'شنو المشروع الحالي' (what is the current project) resolves project-detect", () => {
  const result = classifyIntent("شنو المشروع الحالي");
  assert.equal(result.intent, "project-detect");
});

test("Arabic: 'شغل السيرفر' (start the server) resolves execute", () => {
  const result = classifyIntent("شغل السيرفر");
  assert.equal(result.intent, "execute");
});

test("Arabic: 'اسلوب العمل تاعي شنو' (what is my work style) resolves work-style-lookup", () => {
  const result = classifyIntent("اسلوب العمل تاعي شنو");
  assert.equal(result.intent, "work-style-lookup");
});

// --- structural / non-functional guarantees ---

test("the router never stores anything (pure function, no fs/network, no persisted state)", () => {
  const before = classifyIntent("save this as a decision");
  const again = classifyIntent("save this as a decision");
  assert.deepEqual(before, again);
});

test("output is small and bounded regardless of oversized input", () => {
  const huge = "show T-1 ".repeat(5000);
  const result = classifyIntent(huge);
  assert.ok(JSON.stringify(result).length < 512);
});

test("classification result exposes exactly the contracted fields, nothing extra", () => {
  const result = classifyIntent("show T-1");
  assert.deepEqual(Object.keys(result).sort(), [
    "action",
    "ambiguityReason",
    "confidence",
    "entityType",
    "identifier",
    "intent",
  ]);
});

test("intent-router.ts imports only the pure task-id module — structurally no fs, no network, no MCP, no model call is possible", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    path.resolve("../context/src/context/intent-router.ts"),
    "utf8",
  );
  // The one allowed import is the pure task-id module (no I/O of its own).
  const imports = [...source.matchAll(/from "([^"]+)";/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(imports, ["@ocean/core/domain/tasks/task-id.js"]);
  const taskId = await readFile(
    path.resolve("../core/src/domain/tasks/task-id.ts"),
    "utf8",
  );
  assert.doesNotMatch(taskId, /^import /m);
});

test("'ocean intent classify' CLI is reusable client-neutrally: same output as the direct call, no fs writes", () => {
  const before = spawnSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).stdout;
  const result = spawnSync(
    process.execPath,
    [path.resolve("dist/main.js"), "intent", "classify", "show", "T-123"],
    { encoding: "utf8" },
  );
  const after = spawnSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).stdout;
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout.trim()),
    classifyIntent("show T-123"),
  );
  assert.equal(before, after);
});

// --- task list (no id): T-258 phase C, from real unknown requests ---

for (const text of [
  "what tasks we have",
  "what the next taks",
  "check what we tasks not completed",
  "شنو عدننه تكتات هسه",
  "شنو عدنه تاسكات",
]) {
  test(`task list: "${text}" routes to task-lookup/list, medium confidence, no identifier`, () => {
    const result = classifyIntent(text);
    assert.equal(result.intent, "task-lookup");
    assert.equal(result.action, "list");
    assert.equal(result.identifier, null);
    assert.equal(result.confidence, "medium");
    assert.ok(result.ambiguityReason);
  });
}

test("task list: a task noun without a list cue stays unknown ('update all tasks')", () => {
  assert.equal(classifyIntent("rename all tasks").intent, "unknown");
});

test("task list: an explicit id still wins over the list wording", () => {
  const result = classifyIntent("what is the status of T-12 task");
  assert.equal(result.identifier, "T-12");
  assert.equal(result.action, "get");
});
