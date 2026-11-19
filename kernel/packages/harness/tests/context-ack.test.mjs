import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildOceanBootstrap,
  OCEAN_BOOTSTRAP_MAX_BYTES,
} from "@ocean/context/context/resource-injection.js";
import {
  ackIssued,
  contextAck,
  recordIssuedAck,
} from "@ocean/core/shared/context-ack.js";
import { STORE_DIR } from "@ocean/core/shared/paths.js";
import { claudeSessionStartHook } from "@ocean/loop/hooks/session-start-hook.js";
import {
  readCallLedger,
  resetCallLedgerForTests,
} from "@ocean/services/infrastructure/mcp/call-ledger.js";
import { handleOceanMcpRequest } from "@ocean/services/infrastructure/mcp/ocean-server.js";
import {
  defaultBrainIndexPort,
  defaultSessionStoreFactory,
  defaultWrapperManager,
} from "../dist/composition/runtime.js";

// T-319 F5 CONTEXT-ACK: the start line carries a hash of itself; a client echoes it on its first
// Ocean call, and the call ledger records one context_ack answer per connection.

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
  const text = response.result.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
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

async function inWorkspace(name, run) {
  const previous = process.env.OCEAN_ROOT;
  const root = await mkdtemp(path.join(os.tmpdir(), `ocean-ack-${name}-`));
  for (const [store, index] of [
    ["memory", "MEMORY.md"],
    ["knowledge", "KNOWLEDGE.md"],
  ]) {
    await mkdir(path.join(root, STORE_DIR[store]), { recursive: true });
    await writeFile(path.join(root, STORE_DIR[store], index), "# Index\n");
  }
  process.env.OCEAN_ROOT = root;
  resetCallLedgerForTests();
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

const acks = async () =>
  (await readCallLedger())
    .filter((line) => line.tool === "context_ack")
    .map((line) => [line.client, line.ok]);

test("the start line ends with ack=<hash of the rest>, inside its byte budget", () => {
  const bootstrap = buildOceanBootstrap(
    {
      status: "bound",
      projectId: "demo",
      cwd: "/work/demo",
      gitRoot: null,
      confidence: "high",
      source: "manifest",
    },
    { rules: 3 },
  );
  const match = /^(.*) ack=([0-9a-f]{8})$/.exec(bootstrap.content);
  assert.ok(match, bootstrap.content);
  assert.equal(match[2], contextAck(match[1]));
  assert.equal(bootstrap.ack, match[2]);
  assert.ok(Buffer.byteLength(bootstrap.content) <= OCEAN_BOOTSTRAP_MAX_BYTES);
});

test("only hashes Ocean handed out count, and old ones age out", async () => {
  await inWorkspace("issued", async () => {
    assert.equal(await ackIssued("1a2b3c4d"), false);
    await recordIssuedAck("1a2b3c4d", new Date("2026-01-01T00:00:00Z"));
    assert.equal(await ackIssued("1a2b3c4d"), true);
    for (const junk of [undefined, 7, "1A2B3C4D", "1a2b3c4", "../etc"])
      assert.equal(await ackIssued(junk), false);
    await recordIssuedAck("ffffffff", new Date("2026-03-01T00:00:00Z"));
    assert.equal(await ackIssued("1a2b3c4d"), false);
    assert.equal(await ackIssued("ffffffff"), true);
  });
});

test("a session-start hook notes the hash of the line it hands out", async () => {
  await inWorkspace("hook", async (root) => {
    const result = await claudeSessionStartHook({ cwd: root });
    const ack = /ack=([0-9a-f]{8})/.exec(
      result.hookSpecificOutput.additionalContext,
    )?.[1];
    assert.ok(ack);
    assert.equal(await ackIssued(ack), true);
  });
});

test("one context_ack line per connection: ok when the first call echoes an issued hash", async () => {
  await inWorkspace("mcp", async (root) => {
    // A hookless client: ocean_context first (not judged), then its echo.
    await connect("claude-desktop");
    const line = await call("ocean_context", { cwd: root });
    const ack = /ack=([0-9a-f]{8})$/.exec(line)?.[1];
    assert.ok(ack, line);
    assert.deepEqual(await call("ocean_ping", { contextAck: ack }), {
      ok: true,
    });
    await call("ocean_ping", { contextAck: ack });
    assert.deepEqual(await acks(), [["claude-desktop", true]]);

    // A client that never echoes, and one that echoes a hash Ocean never issued.
    await connect("codex");
    await call("ocean_ping");
    await call("ocean_ping", { contextAck: ack });
    await connect("gemini");
    await call("ocean_ping", { contextAck: "00000000" });
    assert.deepEqual(await acks(), [
      ["claude-desktop", true],
      ["codex", false],
      ["gemini", false],
    ]);
  });
});

test("every tool lists contextAck, and the server takes it off before the tool runs", async () => {
  await inWorkspace("schema", async () => {
    await connect("claude-code");
    const listed = await handle({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/list",
    });
    for (const tool of listed.result.tools)
      assert.equal(
        tool.inputSchema.properties.contextAck?.type,
        "string",
        tool.name,
      );
    const written = await call("memory_write", {
      path: `${STORE_DIR.memory}/x.md`,
      content: "# X\n\nA fact.",
      mode: "create",
      contextAck: "00000000",
    });
    assert.equal(written.path, `${STORE_DIR.memory}/x.md`);
  });
});
