import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reindexBrain } from "@ocean/brain/brain/brain-reindex.js";
import { brainRead, brainSearch } from "@ocean/brain/brain/brain-service.js";
import { readAudit } from "@ocean/brain/memory/memory-audit.js";
import {
  approveCandidate,
  listCandidates,
} from "@ocean/brain/memory/memory-review.js";
import { STORE_DIR, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { handleOceanMcpRequest } from "@ocean/services/infrastructure/mcp/ocean-server.js";
import {
  defaultBrainIndexPort,
  defaultSessionStoreFactory,
  defaultWrapperManager,
} from "../dist/composition/runtime.js";

// Synthetic workspaces only (T-307): a client's proposal made in a project is filed by kind —
// fact → memory/, doc → docs/, todo → review then one backlog line — and written at once only
// when proposeAutoApprove is "project" and the project exists.

let nextId = 1;
const handle = (request) =>
  handleOceanMcpRequest(request, {
    brainIndex: defaultBrainIndexPort,
    sessionStoreFactory: defaultSessionStoreFactory,
    wrapperManager: defaultWrapperManager,
  });

async function call(name, args = {}) {
  const response = await handle({
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (response.error)
    return { error: response.error.message, code: response.error.data?.code };
  return JSON.parse(response.result.content[0].text);
}

const exists = (file) =>
  stat(file).then(
    () => true,
    () => false,
  );

async function inWorkspace(name, { autoApprove = true } = {}, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), `ocean-filing-${name}-`));
  for (const [store, index] of [
    ["memory", "MEMORY.md"],
    ["knowledge", "KNOWLEDGE.md"],
  ]) {
    await mkdir(path.join(root, STORE_DIR[store]), { recursive: true });
    await writeFile(path.join(root, STORE_DIR[store], index), "# Index\n");
  }
  await mkdir(path.join(root, "04-projects", "talk"), { recursive: true });
  await writeFile(
    path.join(root, "04-projects", "talk", "project.json"),
    '{"id":"talk","name":"Talk"}\n',
  );
  await writeFile(
    path.join(root, "04-projects", "backlog.md"),
    "# Backlog\n\n## Open\n\n- [TODO] (P3) talk — older item {2026-11-01}\n",
  );
  await mkdir(path.join(root, SYSTEM_DIR, "config"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "config", "memory.json"),
    JSON.stringify({
      pullAutoApprove: "off",
      ...(autoApprove ? { proposeAutoApprove: "project" } : {}),
    }),
  );
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  await handle({
    jsonrpc: "2.0",
    id: nextId++,
    method: "initialize",
    params: { clientInfo: { name: "filing-test-client" } },
  });
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

test("a fact or doc proposed in an existing project is filed at once in memory/ or docs/", async () => {
  await inWorkspace("auto", {}, async (root) => {
    const fact = await call("memory_propose", {
      content: "# Lesson length\n\nLessons stay under ten minutes.\n",
      origin: "inferred",
      project: "talk",
      kind: "fact",
      name: "lesson-length",
    });
    assert.equal(fact.filed, "04-projects/talk/memory/lesson-length.md");
    const doc = await call("memory_propose", {
      content: "# Exercise flow\n\nListen, repeat, then record.\n",
      origin: "inferred",
      project: "talk",
      kind: "doc",
      name: "exercise-flow",
    });
    assert.equal(doc.filed, "04-projects/talk/docs/exercise-flow.md");
    assert.match(
      await readFile(
        path.join(root, "04-projects/talk/docs/exercise-flow.md"),
        "utf8",
      ),
      /Listen, repeat/,
    );
    // Both candidates were reviewed by the auto-approval, so nothing waits.
    assert.deepEqual(await listCandidates(), []);
    // The written files keep where they came from.
    const written = (await readAudit()).filter((entry) =>
      ["create"].includes(entry.action),
    );
    assert.deepEqual(
      written.map(({ path: file, origin, source }) => [file, origin, source]),
      [
        [
          "04-projects/talk/memory/lesson-length.md",
          "inferred",
          "propose-auto-approve",
        ],
        [
          "04-projects/talk/docs/exercise-flow.md",
          "inferred",
          "propose-auto-approve",
        ],
      ],
    );
    assert.ok(written.every((entry) => entry.candidate));
  });
});

test("an existing file, an unknown project, a todo or the setting off leaves a candidate", async () => {
  await inWorkspace("review", {}, async (root) => {
    const doc = path.join(root, "04-projects/talk/docs/owner-notes.md");
    await mkdir(path.dirname(doc), { recursive: true });
    await writeFile(doc, "# Owner notes\n\nWritten by hand.\n");
    const onDoc = await call("memory_propose", {
      content: "# Owner notes\n\nReplaced?\n",
      origin: "inferred",
      project: "talk",
      kind: "doc",
      name: "owner-notes",
    });
    assert.equal(onDoc.filed, undefined);
    assert.match(onDoc.review, /exists/);
    assert.equal(
      await readFile(doc, "utf8"),
      "# Owner notes\n\nWritten by hand.\n",
    );

    const unknown = await call("memory_propose", {
      content: "A fact for a project Ocean does not have.",
      origin: "inferred",
      project: "ghost",
      kind: "fact",
      name: "ghost-fact",
    });
    assert.match(unknown.review, /no Ocean project 'ghost'/);
    assert.equal(await exists(path.join(root, "04-projects/ghost")), false);

    const todo = await call("memory_propose", {
      content: "Fix the sign-up page\non small screens.",
      origin: "inferred",
      project: "talk",
      kind: "todo",
    });
    assert.match(todo.review, /todo waits for review/);

    const pending = await listCandidates();
    assert.equal(pending.length, 3);
    // Candidate ids made in the same second sort in no fixed order.
    assert.deepEqual(
      pending
        .map((item) => [item.meta.kind, item.meta.project, item.target])
        .sort(),
      [
        ["doc", "talk", "04-projects/talk/docs/owner-notes.md"],
        ["fact", "ghost", ""],
        ["todo", "talk", ""],
      ],
    );
  });
  await inWorkspace("off", { autoApprove: false }, async (root) => {
    const fact = await call("memory_propose", {
      content: "Lessons stay under ten minutes.",
      origin: "inferred",
      project: "talk",
      kind: "fact",
      name: "lesson-length",
    });
    assert.match(fact.review, /proposeAutoApprove is off/);
    assert.equal(
      await exists(path.join(root, "04-projects/talk/memory/lesson-length.md")),
      false,
    );
    // The owner's approval files it where Ocean chose.
    const approved = await approveCandidate({
      id: path.basename(fact.candidate, ".md"),
    });
    assert.equal(approved.path, "04-projects/talk/memory/lesson-length.md");
  });
});

test("an approved todo is one line under the backlog's Open heading, never a task", async () => {
  await inWorkspace("todo", {}, async (root) => {
    const todo = await call("memory_propose", {
      content: "Fix the sign-up page\non small screens.",
      origin: "inferred",
      project: "talk",
      kind: "todo",
    });
    const approved = await approveCandidate({
      id: path.basename(todo.candidate, ".md"),
    });
    assert.equal(approved.path, "04-projects/backlog.md");
    const lines = (
      await readFile(path.join(root, "04-projects/backlog.md"), "utf8")
    ).split("\n");
    assert.equal(lines[2], "## Open");
    assert.match(
      lines[4],
      /^- \[TODO\] \(P2\) talk — Fix the sign-up page on small screens\. \{\d{4}-\d{2}-\d{2}\}$/,
    );
    assert.equal(lines[5], "- [TODO] (P3) talk — older item {2026-11-01}");
    assert.equal(
      await exists(path.join(root, "04-projects/talk/tasks")),
      false,
    );
    const entry = (await readAudit()).find(
      (item) => item.path === "04-projects/backlog.md",
    );
    assert.equal(entry.candidate, path.basename(todo.candidate, ".md"));
    assert.ok(entry.copy, "the backlog before the change is kept");
  });
});

test("filing refuses bad names, ids and mixed arguments, and memory_write cannot touch docs", async () => {
  await inWorkspace("refuse", {}, async () => {
    for (const [args, pattern] of [
      [{ kind: "fact", name: "../escape" }, /kebab-case/],
      [{ kind: "doc", name: "Has Spaces" }, /kebab-case/],
      [{ kind: "fact" }, /kebab-case/],
      [{ kind: "note", name: "x" }, /kind must be fact, doc or todo/],
      [{ kind: "fact", name: "x", project: "../talk" }, /invalid project id/],
      [{ kind: "fact", name: "x", target: "02-personal/x.md" }, /not both/],
    ]) {
      const result = await call("memory_propose", {
        content: "Something.",
        origin: "inferred",
        project: "talk",
        ...args,
      });
      assert.match(result.error ?? "", pattern, JSON.stringify(args));
    }
    const write = await call("memory_write", {
      path: "04-projects/talk/docs/direct.md",
      content: "# Direct\n",
      mode: "create",
    });
    assert.equal(write.code, "OUT_OF_ROOT");
    assert.deepEqual(await listCandidates(), []);
  });
});

test("project docs are indexed in their project's scope and read by workspace path", async () => {
  await inWorkspace("index", {}, async (root) => {
    await call("memory_propose", {
      content:
        "# Exercise flow\n\nListen, repeat, then record a marigold phrase.\n",
      origin: "inferred",
      project: "talk",
      kind: "doc",
      name: "exercise-flow",
    });
    await reindexBrain({
      root,
      indexPort: defaultBrainIndexPort,
      embedder: null,
    });
    const found = await brainSearch({
      root,
      indexPort: defaultBrainIndexPort,
      query: "marigold phrase",
      scope: { project: "talk" },
    });
    assert.equal(found.results[0].path, "project-docs/talk/exercise-flow.md");
    assert.equal(
      found.results[0].file,
      "04-projects/talk/docs/exercise-flow.md",
    );
    assert.equal(found.results[0].scope, "project:talk");
    const elsewhere = await brainSearch({
      root,
      indexPort: defaultBrainIndexPort,
      query: "marigold phrase",
      scope: { project: "other" },
    });
    assert.deepEqual(elsewhere.results, []);
    for (const idOrPath of [
      found.results[0].file,
      "04-projects/talk/docs/exercise-flow",
    ]) {
      const read = await brainRead({
        root,
        indexPort: defaultBrainIndexPort,
        idOrPath,
      });
      assert.equal(read.path, "project-docs/talk/exercise-flow.md");
    }
  });
});
