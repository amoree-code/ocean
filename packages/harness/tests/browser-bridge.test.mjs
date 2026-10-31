import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BrowserBridge,
  browserBridgeConfig,
  browserBridgeMember,
  browserBridgeResponse,
  chromeDebuggingListening,
} from "@ocean/market/mcp/browser-bridge.js";

const PORT = 18931;
const member = {
  capability: "test/browser",
  prefix: "browser",
  command: "unused",
  args: [],
  cwd: "/",
  env: {},
  inheritEnv: false,
};
const tool = { name: "click", inputSchema: { type: "object" } };

function fakeClients(behaviours) {
  const made = [];
  return {
    made,
    client: () => {
      const behaviour = behaviours[made.length] ?? {};
      const client = {
        closed: false,
        calls: [],
        connect: async () => {
          if (behaviour.failStart) throw new Error("no chrome");
        },
        listTools: async () => [tool],
        forwardToolCall: async (name, args) => {
          client.calls.push({ name, args });
          if (behaviour.dies) throw new Error("MCP server stopped");
          return { content: [{ type: "text", text: "done" }] };
        },
        close: () => {
          client.closed = true;
        },
      };
      made.push(client);
      return client;
    },
  };
}

const call = (id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "browser__click", arguments: { uid: "a" } },
});

const post = (bridge, message, overrides = {}) =>
  browserBridgeResponse(
    bridge,
    {
      method: "POST",
      url: "/mcp",
      host: `127.0.0.1:${PORT}`,
      contentType: "application/json",
      body: JSON.stringify(message),
      ...overrides,
    },
    PORT,
    async () => true,
  );

test("the config points at loopback and the upstream keeps URLs on the machine", () => {
  assert.deepEqual(browserBridgeConfig(PORT).mcpServers["ocean-browser"], {
    type: "http",
    url: `http://127.0.0.1:${PORT}/mcp`,
  });
  const { args } = browserBridgeMember();
  assert.ok(args.includes("--autoConnect"));
  assert.ok(args.includes("--no-performance-crux"));
  assert.ok(args.includes("--no-usage-statistics"));
  assert.ok(
    args.some((arg) => /^chrome-devtools-mcp@\d+\.\d+\.\d+$/.test(arg)),
  );
});

test("initialize names the service and states what the access means", async () => {
  const { client } = fakeClients([]);
  const bridge = new BrowserBridge({ client, member });
  const { status, body } = await post(bridge, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
  });
  assert.equal(status, 200);
  assert.equal(body.result.serverInfo.name, "ocean-browser");
  assert.match(body.result.instructions, /real Chrome/);
  assert.match(body.result.instructions, /untrusted/);
  bridge.close();
});

test("tools are listed and calls reach the upstream with their arguments", async () => {
  const { client, made } = fakeClients([]);
  const bridge = new BrowserBridge({ client, member });
  const list = await post(bridge, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  assert.deepEqual(
    list.body.result.tools.map(({ name }) => name),
    ["browser__click"],
  );
  const result = await post(bridge, call(2));
  assert.equal(result.body.result.content[0].text, "done");
  assert.deepEqual(made[0].calls, [{ name: "click", args: { uid: "a" } }]);
  bridge.close();
});

test("notifications get 202 and no body", async () => {
  const { client } = fakeClients([]);
  const bridge = new BrowserBridge({ client, member });
  const { status, body } = await post(bridge, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  assert.equal(status, 202);
  assert.equal(body, undefined);
  bridge.close();
});

test("a dead upstream fails that call once, is not retried, and the next call recovers", async () => {
  const { client, made } = fakeClients([{ dies: true }, {}]);
  const bridge = new BrowserBridge({ client, member });
  const failed = await post(bridge, call(1));
  assert.match(failed.body.error.message, /MCP server stopped/);
  assert.equal(made[0].calls.length, 1);
  assert.equal(made[0].closed, true);
  const recovered = await post(bridge, call(2));
  assert.equal(recovered.body.result.content[0].text, "done");
  assert.equal(made.length, 2);
  bridge.close();
});

test("an upstream that failed to start is tried again on the next request", async () => {
  const { client, made } = fakeClients([{ failStart: true }, {}]);
  const bridge = new BrowserBridge({ client, member });
  const recovered = await post(bridge, call(1));
  assert.equal(recovered.body.result.content[0].text, "done");
  assert.equal(made[0].closed, true);
  assert.equal(made.length, 2);
  bridge.close();
});

test("web pages and foreign hosts are refused before reaching the upstream", async () => {
  const { client, made } = fakeClients([]);
  const bridge = new BrowserBridge({ client, member });
  for (const overrides of [
    { host: "evil.example" },
    { host: `evil.example:${PORT}` },
    { host: undefined },
    { origin: "https://evil.example" },
    { origin: "http://localhost:3000" },
    { origin: "null" },
  ])
    assert.equal((await post(bridge, call(), overrides)).status, 403);
  assert.equal(
    (await post(bridge, call(), { contentType: "text/plain" })).status,
    415,
  );
  assert.equal(made[0]?.calls.length ?? 0, 0);
  bridge.close();
});

test("the HTTP surface answers only what it serves", async () => {
  const { client } = fakeClients([]);
  const bridge = new BrowserBridge({ client, member });
  const get = await post(bridge, call(), { method: "GET" });
  assert.equal(get.status, 405);
  assert.equal(get.headers.Allow, "POST");
  assert.equal((await post(bridge, call(), { url: "/other" })).status, 404);
  assert.equal((await post(bridge, call(), { body: "{" })).status, 400);
  const health = await post(bridge, call(), { method: "GET", url: "/health" });
  assert.equal(health.status, 200);
  assert.equal(health.body.chromeDebuggingListening, true);
  bridge.close();
});

test("a missing or malformed DevToolsActivePort means Chrome is not listening", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-bridge-"));
  assert.equal(await chromeDebuggingListening(path.join(dir, "absent")), false);
  const file = path.join(dir, "DevToolsActivePort");
  await writeFile(file, "not-a-port\n/devtools/browser/x\n");
  assert.equal(await chromeDebuggingListening(file), false);
});
