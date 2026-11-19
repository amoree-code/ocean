import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";
import { resetCallLedgerForTests } from "@ocean/services/infrastructure/mcp/call-ledger.js";
import { createMcpSessionRecorder } from "@ocean/services/infrastructure/mcp/mcp-session.js";
import { handleOceanMcpRequest } from "@ocean/services/infrastructure/mcp/ocean-server.js";
import {
  MCP_ONLY_CLIENTS,
  mcpClientOf,
} from "../dist/application/clients/registry.js";
import {
  defaultBrainIndexPort,
  defaultSessionStoreFactory,
  defaultWrapperManager,
} from "../dist/composition/runtime.js";

// T-319: Claude Desktop, which Ocean sees only over MCP, gets a light session per connection.

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-mcp-session-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  resetCallLedgerForTests();
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

async function sessions() {
  const store = await openSessionStore();
  try {
    return store.list().map((session) => ({
      session,
      events: store.listEvents(session.sessionId),
    }));
  } finally {
    store.close();
  }
}

// The same provider mapping `ocean mcp serve` uses.
const providerOf = (name) => {
  const id = mcpClientOf(name)?.id;
  return id && MCP_ONLY_CLIENTS.has(id) ? id : null;
};

test("only Claude Desktop is an MCP-only client; its chat and agent modes both map to it", () => {
  assert.deepEqual([...MCP_ONLY_CLIENTS], ["claude-desktop"]);
  assert.equal(providerOf("claude-ai"), "claude-desktop");
  assert.equal(providerOf("local-agent-mode-ocean"), "claude-desktop");
  // Recorded elsewhere (hooks, interception) or unknown: no MCP session.
  assert.equal(providerOf("claude-code"), null);
  assert.equal(providerOf("opencode"), null);
  assert.equal(providerOf("unknown"), null);
});

test("one session per connection, opened on the first call, tool names only, completed on close", async () => {
  await withRoot(async () => {
    const recorder = createMcpSessionRecorder({
      openStore: defaultSessionStoreFactory,
      providerOf,
      cwd: "/",
    });
    // Nothing is recorded before a tool call, or for a client recorded elsewhere.
    await recorder.close();
    await recorder.toolCall("claude-code", "brain_search", true);
    assert.equal((await sessions()).length, 0);

    await recorder.toolCall("claude-ai", "brain_search", true);
    await recorder.toolCall("claude-ai", "memory_write", false);
    let all = await sessions();
    assert.equal(all.length, 1);
    const [{ session, events }] = all;
    assert.equal(session.provider, "claude-desktop");
    assert.equal(session.profile, "mcp:claude-desktop");
    assert.equal(session.status, "running");
    assert.deepEqual(
      events.map((event) => [event.type, JSON.parse(event.data)]),
      [
        ["mcp_connection", { client: "claude-ai" }],
        ["mcp_tool_call", { tool: "brain_search", ok: true }],
        ["mcp_tool_call", { tool: "memory_write", ok: false }],
      ],
    );
    await recorder.close();
    all = await sessions();
    assert.equal(all[0].session.status, "completed");
  });
});

test("a store that cannot open never fails the tool call", async () => {
  const recorder = createMcpSessionRecorder({
    openStore: async () => {
      throw new Error("disk full");
    },
    providerOf: () => "claude-desktop",
  });
  await assert.doesNotReject(
    recorder.toolCall("claude-ai", "ocean_ping", true),
  );
  await assert.doesNotReject(recorder.close());
});

test("over MCP: a Claude Desktop connection's calls land in one session, arguments never", async () => {
  await withRoot(async () => {
    const mcpSessions = createMcpSessionRecorder({
      openStore: defaultSessionStoreFactory,
      providerOf,
    });
    const handle = (request) =>
      handleOceanMcpRequest(request, {
        brainIndex: defaultBrainIndexPort,
        sessionStoreFactory: defaultSessionStoreFactory,
        wrapperManager: defaultWrapperManager,
        mcpSessions,
      });
    await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "claude-ai" } },
    });
    await handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "ocean_ping", arguments: { note: "mcp-session-canary" } },
    });
    const [{ session, events }] = await sessions();
    assert.equal(session.provider, "claude-desktop");
    assert.deepEqual(
      events.map((event) => event.type),
      ["mcp_connection", "mcp_tool_call"],
    );
    assert.ok(
      !events.some((event) => event.data.includes("mcp-session-canary")),
    );
  });
});

test("the real `ocean mcp serve` process completes the session after answering calls already sent", async () => {
  const { spawnSync } = await import("node:child_process");
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-mcp-serve-"));
  const lines = [
    {
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "claude-ai" } },
    },
    {
      id: 2,
      method: "tools/call",
      params: { name: "ocean_ping", arguments: {} },
    },
    {
      id: 3,
      method: "tools/call",
      params: { name: "ocean_ping", arguments: {} },
    },
  ].map((request) => JSON.stringify({ jsonrpc: "2.0", ...request }));
  // All input at once, then end: stdin closes while the calls are still being answered.
  const result = spawnSync(
    process.execPath,
    [path.resolve("dist/main.js"), "mcp", "serve"],
    {
      input: `${lines.join("\n")}\n`,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        OCEAN_ROOT: root,
        OCEAN_NO_AUTO_REINDEX: "1",
        OCEAN_NO_PULL_ON_START: "1",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split("\n").length, 3);
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    const [{ session, events }] = await sessions();
    assert.equal(session.provider, "claude-desktop");
    assert.equal(session.status, "completed");
    assert.equal(events.filter((e) => e.type === "mcp_tool_call").length, 2);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});
