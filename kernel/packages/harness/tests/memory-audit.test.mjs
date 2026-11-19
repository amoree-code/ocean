import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendAudit,
  auditSummary,
  currentSession,
  readAudit,
} from "@ocean/brain/memory/memory-audit.js";
import { STORE_DIR } from "@ocean/core/shared/paths.js";
import { handleOceanMcpRequest } from "@ocean/services/infrastructure/mcp/ocean-server.js";
import {
  defaultBrainIndexPort,
  defaultSessionStoreFactory,
  defaultWrapperManager,
} from "../dist/composition/runtime.js";

// T-319: every memory change names its client and, when the client exposes one, its session;
// `ocean memory audit` answers who wrote, changed or deleted what. Synthetic workspaces only.

const PERSONAL = STORE_DIR.memory;
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
  assert.equal(response.error, undefined, response.error?.message);
  return JSON.parse(response.result.content[0].text);
}

async function inWorkspace(name, env, run) {
  const saved = {};
  const root = await mkdtemp(path.join(os.tmpdir(), `ocean-audit-${name}-`));
  for (const [store, index] of [
    ["memory", "MEMORY.md"],
    ["knowledge", "KNOWLEDGE.md"],
  ]) {
    await mkdir(path.join(root, STORE_DIR[store]), { recursive: true });
    await writeFile(path.join(root, STORE_DIR[store], index), "# Index\n");
  }
  const vars = { OCEAN_ROOT: root, ...env };
  for (const key of [
    ...Object.keys(vars),
    "OCEAN_SESSION_ID",
    "CLAUDE_CODE_SESSION_ID",
  ]) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    await run(root);
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
}

async function connect(client) {
  await handle({
    jsonrpc: "2.0",
    id: nextId++,
    method: "initialize",
    params: { clientInfo: { name: client } },
  });
}

test("currentSession prefers OCEAN_SESSION_ID, falls back to Claude Code's, ignores junk", () => {
  assert.equal(
    currentSession({ OCEAN_SESSION_ID: "a1", CLAUDE_CODE_SESSION_ID: "b2" }),
    "a1",
  );
  assert.equal(currentSession({ CLAUDE_CODE_SESSION_ID: "b2" }), "b2");
  assert.equal(currentSession({}), undefined);
  assert.equal(currentSession({ OCEAN_SESSION_ID: "a b\n" }), undefined);
  assert.equal(
    currentSession({ OCEAN_SESSION_ID: "x".repeat(129) }),
    undefined,
  );
});

test("MCP writes, proposals and deletes record the client and its session", async () => {
  const session = "3b5d2117-7896-4acd-a3f3-c0ecf5381141";
  await inWorkspace("mcp", { CLAUDE_CODE_SESSION_ID: session }, async () => {
    await connect("claude-code");
    const target = `${PERSONAL}/travel/visa.md`;
    const written = await call("memory_write", {
      path: target,
      content: "# Visa\n\nApplied.",
      mode: "create",
    });
    await call("memory_propose", {
      content: "Prefers aisle seats.",
      origin: "inferred",
    });
    await call("memory_delete", { path: target, expectedHash: written.sha256 });
    const entries = await readAudit();
    assert.deepEqual(
      entries.map((entry) => [entry.action, entry.source, entry.session]),
      [
        ["create", "claude-code", session],
        ["propose", "claude-code", session],
        ["delete", "claude-code", session],
      ],
    );
  });
});

test("a client that exposes no session writes no session field", async () => {
  await inWorkspace("nosession", {}, async () => {
    await connect("codex");
    await call("memory_propose", { content: "A fact.", origin: "inferred" });
    const [entry] = await readAudit();
    assert.equal(entry.source, "codex");
    assert.equal("session" in entry, false);
  });
});

test("auditSummary counts per client and action, filters by client and days, flags unknown", async () => {
  await inWorkspace("summary", {}, async () => {
    const base = { beforeSha: null, afterSha: "x" };
    await appendAudit({
      ...base,
      action: "create",
      path: "a.md",
      source: "codex",
    });
    await appendAudit({
      ...base,
      action: "update",
      path: "a.md",
      source: "codex",
    });
    await appendAudit({
      ...base,
      action: "propose",
      path: "b.md",
      source: "session:s1",
    });
    await appendAudit({
      ...base,
      action: "delete",
      path: "c.md",
      source: "unknown",
    });

    const all = await auditSummary();
    assert.equal(all.total, 4);
    assert.equal(all.unknown, 1);
    assert.equal(all.since, null);
    assert.deepEqual(all.clients[0], {
      client: "codex",
      total: 2,
      actions: { create: 1, update: 1 },
    });
    assert.deepEqual(
      all.entries.map((entry) => entry.path),
      ["c.md", "b.md", "a.md", "a.md"],
    );

    const codex = await auditSummary({ client: "codex", limit: 1 });
    assert.equal(codex.total, 2);
    assert.equal(codex.entries.length, 1);
    assert.equal((await auditSummary({ client: "session" })).total, 1);

    const later = new Date(Date.now() + 3 * 86_400_000);
    assert.equal((await auditSummary({ days: 1, now: later })).total, 0);
    assert.equal((await auditSummary({ days: 7, now: later })).total, 4);
  });
});

test("`ocean memory audit` prints the summary, as JSON on request, and rejects bad flags", async () => {
  await inWorkspace("cli", {}, async (root) => {
    await appendAudit({
      action: "create",
      path: `${PERSONAL}/x.md`,
      source: "gemini",
      session: "s-9",
      beforeSha: null,
      afterSha: "x",
    });
    const run = (...args) =>
      spawnSync(
        process.execPath,
        [path.resolve("dist/main.js"), "memory", "audit", ...args],
        {
          encoding: "utf8",
          env: { ...process.env, OCEAN_ROOT: root },
        },
      );
    const text = run("--days", "7");
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /: 1 \(0 unknown\)/);
    assert.match(text.stdout, /gemini\s+1\s+create 1/);
    assert.match(text.stdout, /\(session s-9\)/);

    const json = JSON.parse(run("--client", "gemini", "--json").stdout);
    assert.equal(json.total, 1);
    assert.equal(json.entries[0].session, "s-9");
    assert.equal(
      JSON.parse(run("--client", "codex", "--json").stdout).total,
      0,
    );

    assert.notEqual(run("--days", "soon").status, 0);
    assert.notEqual(run("--client").status, 0);
  });
});
