import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CALL_LEDGER_RETENTION_DAYS,
  callLedgerFile,
  ledgerLine,
  pruneLedgerText,
  readCallLedger,
  resetCallLedgerForTests,
  summarizeCallLedger,
} from "@ocean/services/infrastructure/mcp/call-ledger.js";
import { handleOceanMcpRequest } from "@ocean/services/infrastructure/mcp/ocean-server.js";
import { attributeLedger } from "../dist/application/clients/clients.js";
import {
  CLIENT_ADAPTERS,
  mcpClientOf,
} from "../dist/application/clients/registry.js";
import {
  defaultBrainIndexPort,
  defaultSessionStoreFactory,
  defaultWrapperManager,
} from "../dist/composition/runtime.js";

const handle = (request) =>
  handleOceanMcpRequest(request, {
    brainIndex: defaultBrainIndexPort,
    sessionStoreFactory: defaultSessionStoreFactory,
    wrapperManager: defaultWrapperManager,
  });

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-call-ledger-"));
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

const SECRET = "ledger-canary-question-text";

test("the call ledger records only {ts, client, tool, ok} — never questions, inputs or results", async () => {
  await withRoot(async () => {
    await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "ledger-test-client" } },
    });
    await handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "ocean_ping", arguments: {} },
    });
    await handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "brain_search",
        arguments: { query: `what is my password ${SECRET}` },
      },
    });
    // Fails: no taskId. Its error text must not reach the ledger either.
    await handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "ocean_task_get", arguments: { note: SECRET } },
    });
    // The requested name is caller text: logged as "unknown", never verbatim.
    await handle({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: `evil ${SECRET}`, arguments: {} },
    });
    await handle({
      jsonrpc: "2.0",
      id: 6,
      method: "resources/read",
      params: { uri: `ocean://${SECRET}` },
    });
    const text = await readFile(callLedgerFile(), "utf8");
    assert.doesNotMatch(text, new RegExp(SECRET));
    assert.doesNotMatch(text, /password|taskId|required/);
    const calls = await readCallLedger();
    for (const call of calls)
      assert.deepEqual(Object.keys(call).sort(), [
        "client",
        "ok",
        "tool",
        "ts",
      ]);
    assert.deepEqual(
      calls.map(({ client, tool, ok }) => [client, tool, ok]),
      [
        ["ledger-test-client", "ocean_ping", true],
        // No index in the empty workspace, so the search fails; its error stays out too.
        ["ledger-test-client", "brain_search", false],
        ["ledger-test-client", "ocean_task_get", false],
        ["ledger-test-client", "unknown", false],
        ["ledger-test-client", "resources/read", false],
      ],
    );
    if (process.platform !== "win32")
      assert.equal((await stat(callLedgerFile())).mode & 0o777, 0o600);
    assert.deepEqual(
      summarizeCallLedger(calls).find((row) => row.tool === "ocean_ping"),
      {
        client: "ledger-test-client",
        tool: "ocean_ping",
        calls: 1,
        ok: 1,
        last: calls[0].ts,
      },
    );
  });
});

test("ledger lines are built field by field and sanitize names", () => {
  const line = JSON.parse(
    ledgerLine("bad\nclient", "tool;rm -rf", true, new Date(0)),
  );
  assert.deepEqual(line, {
    ts: "1970-01-01T00:00:00.000Z",
    client: "unknown",
    tool: "unknown",
    ok: true,
  });
  assert.equal(JSON.parse(ledgerLine("codex", "brain_read", "yes")).ok, false);
});

test("the ledger keeps 90 days and drops torn lines", () => {
  const now = new Date("2026-11-02T00:00:00Z");
  const day = 86_400_000;
  const at = (days) =>
    JSON.stringify({
      ts: new Date(now.getTime() - days * day).toISOString(),
      client: "c",
      tool: "t",
      ok: true,
    });
  assert.equal(CALL_LEDGER_RETENTION_DAYS, 90);
  const kept = pruneLedgerText(
    [at(120), at(91), "{torn", at(89), at(0), ""].join("\n"),
    now,
  );
  assert.deepEqual(kept.trim().split("\n"), [at(89), at(0)]);
  assert.equal(pruneLedgerText(`${at(200)}\n`, now), "");
});

test("Claude Desktop's chat and agent mode stay two identities of one client", async () => {
  await withRoot(async () => {
    for (const [id, name] of [
      [1, "claude-ai"],
      [3, "local-agent-mode-ocean"],
      [5, "codex-mcp-client"],
    ]) {
      await handle({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: { clientInfo: { name } },
      });
      await handle({
        jsonrpc: "2.0",
        id: id + 1,
        method: "tools/call",
        params: { name: "ocean_ping", arguments: {} },
      });
    }
    const rows = attributeLedger(summarizeCallLedger(await readCallLedger()));
    const row = (client) => rows.find((item) => item.client === client);
    // The ledger keeps the name the client sent; attribution only adds to it.
    assert.deepEqual(
      rows.map(({ client, oceanClient, mode }) => [client, oceanClient, mode]),
      [
        ["claude-ai", "claude-desktop", "chat"],
        // An unidentified name is not guessed at.
        ["codex-mcp-client", undefined, undefined],
        ["local-agent-mode-ocean", "claude-desktop", "agent"],
      ],
    );
    assert.equal(row("claude-ai").calls, 1);
    assert.equal(row("local-agent-mode-ocean").calls, 1);
  });
});

test("every MCP client name belongs to one client, and single-name clients have no mode", () => {
  const names = CLIENT_ADAPTERS.flatMap((adapter) =>
    (adapter.mcpClients ?? []).map((item) => item.name),
  );
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(mcpClientOf("claude-code"), { id: "claude-code" });
  assert.deepEqual(mcpClientOf("opencode"), { id: "opencode" });
  assert.equal(mcpClientOf("claude-desktop"), undefined);
  assert.equal(mcpClientOf("unknown"), undefined);
});
