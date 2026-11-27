import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  errorHint,
  gatewayManifestStore,
  McpGateway,
} from "@ocean/market/mcp/mcp-gateway.js";
import { planMcpLaunch } from "@ocean/market/mcp/mcp-launch.js";
import { McpClient } from "@ocean/services/infrastructure/mcp/mcp-client.js";
import { gatewayClientFor } from "../dist/interfaces/cli/mcp-gateway-command.js";

// A stdio MCP server that records each start in a file, echoes calls, fails `fail` with the text
// it is given, answers `roots` with the roots it asks its client for, and on `grow` adds a tool
// and sends `notifications/tools/list_changed`.
const fakeServer = `
const fs = require("node:fs");
const [name, tools, starts] = [process.argv[2], JSON.parse(process.argv[3]), process.argv[4]];
fs.appendFileSync(starts, name + "\\n");
let b = "";
const waiting = new Map();
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  b += c;
  for (let n = b.indexOf("\\n"); n >= 0; n = b.indexOf("\\n")) {
    const l = b.slice(0, n).trim(); b = b.slice(n + 1);
    if (!l) continue;
    const q = JSON.parse(l);
    if (q.method === undefined) { waiting.get(q.id)?.(q); continue; }
    if (q.id === undefined) continue;
    if (q.method === "tools/call" && q.params.name === "roots") {
      waiting.set("r" + q.id, (answer) => send({ jsonrpc: "2.0", id: q.id, result: { content: [{ type: "text", text: JSON.stringify(answer.result ?? answer.error) }] } }));
      send({ jsonrpc: "2.0", id: "r" + q.id, method: "roots/list" });
      continue;
    }
    if (q.method === "tools/call" && q.params.name === "grow") {
      tools.push({ name: "grown" });
      send({ jsonrpc: "2.0", id: q.id, result: { content: [{ type: "text", text: "grew" }] } });
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      continue;
    }
    const result = q.method === "tools/list" ? { tools }
      : q.method === "tools/call" && q.params.name === "fail" ? { isError: true, content: [{ type: "text", text: q.params.arguments.text }] }
      : q.method === "tools/call" ? { content: [{ type: "text", text: name + ":" + q.params.name }] }
      : {};
    send({ jsonrpc: "2.0", id: q.id, result });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-gateway-profiles-"));
  const script = path.join(root, "server.cjs");
  const starts = path.join(root, "starts.log");
  await writeFile(script, fakeServer);
  await writeFile(starts, "");
  const member = (capability, prefix, tools) => ({
    capability,
    prefix,
    command: process.execPath,
    args: [
      script,
      prefix,
      JSON.stringify(tools.map((name) => ({ name }))),
      starts,
    ],
    cwd: root,
    env: {},
    inheritEnv: true,
  });
  const members = [
    member("dev.ocean/ocean", "ocean", ["ocean_status"]),
    member("dev.ocean/chrome-devtools", "chrome-devtools", [
      "list_pages",
      "fail",
      "roots",
    ]),
    member("test/ocean-uiux", "ocean-uiux", ["search_components"]),
  ];
  const started = async () =>
    (await readFile(starts, "utf8")).split("\n").filter(Boolean);
  return { root, members, started };
}

const profiles = (active) => {
  const available = [
    { name: "base", mcp: [] },
    { name: "frontend", mcp: ["ocean-uiux", "chrome-devtools"] },
    { name: "qa-testing", mcp: ["chrome-devtools"] },
    { name: "ocean-ops", mcp: ["ocean"] },
  ];
  return {
    active: available.find((profile) => profile.name === active),
    available,
  };
};

function gatewayFor(members, options = {}) {
  const log = [];
  const gateway = new McpGateway(members, {
    client: (member, context) =>
      new McpClient({ ...member, roots: context.roots }),
    version: "test",
    timeoutMs: 3000,
    log: (line) => log.push(line),
    ungated: ["dev.ocean/ocean"],
    ...options,
  });
  return { gateway, log };
}

const names = async (gateway) =>
  (await gateway.tools()).map((tool) => tool.name).sort();

test("a profile lists only its own gateway members, and Ocean's server in every one", async () => {
  const { members, started } = await fixture();
  const base = gatewayFor(members, { profiles: profiles("base") });
  try {
    // base: no gateway member of its own; the switch tool is the only addition.
    assert.deepEqual(await names(base.gateway), [
      "gateway__use_profile",
      "ocean__ocean_status",
    ]);
    // A member outside the profile never starts.
    assert.deepEqual(await started(), ["ocean"]);
    assert.ok(
      base.log.some((line) =>
        /profile base: leaves out dev\.ocean\/chrome-devtools, test\/ocean-uiux/.test(
          line,
        ),
      ),
      base.log.join("\n"),
    );
  } finally {
    base.gateway.close();
  }
  const frontend = gatewayFor(members, { profiles: profiles("frontend") });
  try {
    assert.deepEqual(await names(frontend.gateway), [
      "chrome-devtools__fail",
      "chrome-devtools__list_pages",
      "chrome-devtools__roots",
      "gateway__use_profile",
      "ocean-uiux__search_components",
      "ocean__ocean_status",
    ]);
    const tool = (await frontend.gateway.tools()).find(
      (candidate) => candidate.name === "gateway__use_profile",
    );
    assert.match(tool.description, /Active: frontend/);
    assert.match(tool.description, /qa-testing \(chrome-devtools\)/);
  } finally {
    frontend.gateway.close();
  }
  // Without profiles every member is listed and there is no switch tool.
  const open = gatewayFor(members);
  try {
    assert.ok(!(await names(open.gateway)).includes("gateway__use_profile"));
    assert.equal((await names(open.gateway)).length, 5);
  } finally {
    open.gateway.close();
  }
});

test("use_profile switches the listed tools and tells the client its list changed", async () => {
  const { members } = await fixture();
  const { gateway } = gatewayFor(members, { profiles: profiles("base") });
  const sent = [];
  gateway.attach((message) => sent.push(message));
  try {
    const init = await gateway.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    assert.deepEqual(init.result.capabilities.tools, { listChanged: true });
    await gateway.handle({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    const unknown = await gateway.call("gateway__use_profile", {
      name: "nope",
    });
    assert.equal(unknown.isError, true);
    const switched = await gateway.call("gateway__use_profile", {
      name: "qa-testing",
    });
    assert.match(
      switched.content[0].text,
      /qa-testing is active; tools from chrome-devtools/,
    );
    assert.equal(gateway.profile, "qa-testing");
    const listed = await names(gateway);
    assert.ok(
      listed.includes("chrome-devtools__list_pages"),
      listed.join(", "),
    );
    assert.ok(!listed.some((name) => name.startsWith("ocean-uiux__")));
    assert.ok(
      sent.some(
        (message) => message.method === "notifications/tools/list_changed",
      ),
      JSON.stringify(sent),
    );
    const call = await gateway.call("chrome-devtools__list_pages", {});
    assert.equal(call.content[0].text, "chrome-devtools:list_pages");
  } finally {
    gateway.close();
  }
});

test("the gateway follows the prompt hook's selection, and only ever widens", async () => {
  const { members, started } = await fixture();
  const { gateway, log } = gatewayFor(members, { profiles: profiles("base") });
  const sent = [];
  gateway.attach((message) => sent.push(message));
  try {
    await gateway.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    await gateway.handle({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    assert.deepEqual(await names(gateway), [
      "gateway__use_profile",
      "ocean__ocean_status",
    ]);
    // A front-end prompt: chrome-devtools and ocean-uiux appear without use_profile.
    assert.equal(
      await gateway.followSelection({ primary: "frontend", secondary: [] }),
      true,
    );
    assert.equal(gateway.profile, "frontend");
    const listed = await names(gateway);
    assert.ok(
      listed.includes("chrome-devtools__list_pages"),
      listed.join(", "),
    );
    assert.ok(
      listed.includes("ocean-uiux__search_components"),
      listed.join(", "),
    );
    assert.ok(
      sent.some((m) => m.method === "notifications/tools/list_changed"),
    );
    assert.ok(
      log.some((line) => /from the prompt hook's selection/.test(line)),
      log.join("\n"),
    );
    // A narrower selection later never takes tools away.
    sent.length = 0;
    assert.equal(
      await gateway.followSelection({ primary: "base", secondary: [] }),
      false,
    );
    assert.deepEqual(await names(gateway), listed);
    assert.equal(sent.length, 0);
    // The same selection again changes nothing; an unknown name widens nothing.
    assert.equal(
      await gateway.followSelection({ primary: "frontend", secondary: [] }),
      false,
    );
    assert.equal(
      await gateway.followSelection({ primary: "nope", secondary: ["nope"] }),
      false,
    );
    assert.equal(
      (await started()).filter((name) => name === "chrome-devtools").length,
      1,
    );
  } finally {
    gateway.close();
  }
  // Without profiles there is nothing to follow.
  const open = gatewayFor(members);
  try {
    assert.equal(
      await open.gateway.followSelection({
        primary: "frontend",
        secondary: [],
      }),
      false,
    );
  } finally {
    open.gateway.close();
  }
});

test("a member's own list_changed reaches the client, with the new tool listed", async () => {
  const { members } = await fixture();
  const devtools = members[1];
  devtools.args[2] = JSON.stringify([
    ...JSON.parse(devtools.args[2]),
    { name: "grow" },
  ]);
  const { gateway } = gatewayFor(members, {
    client: (member, context) =>
      gatewayClientFor(member, "test", undefined, context),
  });
  const sent = [];
  gateway.attach((message) => sent.push(message));
  try {
    await gateway.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    await gateway.handle({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    assert.ok(!(await names(gateway)).includes("chrome-devtools__grown"));
    const grew = await gateway.call("chrome-devtools__grow", {});
    assert.equal(grew.content[0].text, "grew");
    const deadline = Date.now() + 2000;
    while (
      !(await names(gateway)).includes("chrome-devtools__grown") &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok((await names(gateway)).includes("chrome-devtools__grown"));
    assert.ok(
      sent.some((m) => m.method === "notifications/tools/list_changed"),
      JSON.stringify(sent),
    );
  } finally {
    gateway.close();
  }
});

test("a member with a cached manifest is listed without starting, and starts on its first call", async () => {
  const { root, members, started } = await fixture();
  const dir = path.join(root, "manifests");
  const first = gatewayFor(members, {
    manifests: gatewayManifestStore(dir, "1.0.0"),
  });
  try {
    assert.equal((await names(first.gateway)).length, 5);
  } finally {
    first.gateway.close();
  }
  assert.equal((await started()).length, 3);
  const second = gatewayFor(members, {
    manifests: gatewayManifestStore(dir, "1.0.0"),
  });
  try {
    assert.equal((await names(second.gateway)).length, 5);
    assert.equal((await started()).length, 3, "nothing started for a listing");
    const call = await second.gateway.call("ocean-uiux__search_components", {});
    assert.equal(call.content[0].text, "ocean-uiux:search_components");
    assert.deepEqual((await started()).slice(3), ["ocean-uiux"]);
  } finally {
    second.gateway.close();
  }
  // Another Ocean version, or another command, is another manifest.
  assert.equal(
    await gatewayManifestStore(dir, "1.0.1").read(members[0]),
    undefined,
  );
  assert.equal(
    await gatewayManifestStore(dir, "1.0.0").read({
      ...members[0],
      args: ["other"],
    }),
    undefined,
  );
  assert.ok(await gatewayManifestStore(dir, "1.0.0").read(members[0]));
});

test("a stale page or uid error carries a one-line hint naming the next call", async () => {
  assert.match(errorHint("No page found for id 3") ?? "", /list_pages/);
  assert.match(
    errorHint('Element with uid "1_23" not found') ?? "",
    /take_snapshot/,
  );
  assert.equal(errorHint("Network timeout"), undefined);
  const { members } = await fixture();
  const { gateway } = gatewayFor(members);
  try {
    const result = await gateway.call("chrome-devtools__fail", {
      text: "Page ids have changed",
    });
    assert.equal(result.isError, true);
    assert.equal(result.content.length, 2);
    assert.match(result.content[1].text, /list_pages/);
    const plain = await gateway.call("chrome-devtools__fail", { text: "boom" });
    assert.equal(plain.content.length, 1);
  } finally {
    gateway.close();
  }
});

test("a member's roots/list gets the client's roots, or the gateway's folder", async () => {
  const { members } = await fixture();
  const fallback = gatewayFor(members, { roots: [{ uri: "file:///project" }] });
  try {
    const result = await fallback.gateway.call("chrome-devtools__roots", {});
    assert.deepEqual(JSON.parse(result.content[0].text), {
      roots: [{ uri: "file:///project" }],
    });
  } finally {
    fallback.gateway.close();
  }
  const { gateway } = gatewayFor(members, {
    roots: [{ uri: "file:///project" }],
  });
  // The client offers roots, so the gateway asks it and passes its answer on.
  gateway.attach((message) => {
    if (message.method === "roots/list")
      void gateway.handle({
        jsonrpc: "2.0",
        id: message.id,
        result: { roots: [{ uri: "file:///client", name: "client" }] },
      });
  });
  try {
    await gateway.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: { roots: { listChanged: true } } },
    });
    const result = await gateway.call("chrome-devtools__roots", {});
    assert.deepEqual(JSON.parse(result.content[0].text), {
      roots: [{ uri: "file:///client", name: "client" }],
    });
  } finally {
    gateway.close();
  }
});

test("an exact npm version runs from its pinned copy, else through npx with a pin request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-mcp-pin-"));
  const installed = (version) => ({
    capability: "com.example/files",
    version: "1.0.0",
    permissions: {
      filesystem: { read: [], write: [] },
      network: [],
      env: [],
      exec: ["npx"],
    },
    server: {
      name: "com.example/files",
      packages: [
        { registryType: "npm", identifier: "@example/files-mcp", version },
      ],
    },
  });
  const packagesRoot = path.join(root, "packages");
  const options = {
    stateDir: root,
    packagesRoot,
    execPath: "/opt/node/bin/node",
  };
  const unpinned = planMcpLaunch(installed("1.2.3"), options);
  assert.equal(unpinned.command, "npx");
  assert.deepEqual(unpinned.pin, {
    identifier: "@example/files-mcp",
    version: "1.2.3",
  });
  // A range is never pinned.
  assert.equal(planMcpLaunch(installed("^1.2.3"), options).pin, undefined);
  const packageDir = path.join(
    packagesRoot,
    "@example__files-mcp@1.2.3",
    "node_modules",
    "@example",
    "files-mcp",
  );
  await mkdir(path.join(packageDir, "bin"), { recursive: true });
  await writeFile(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "@example/files-mcp",
      version: "1.2.3",
      bin: { "files-mcp": "bin/cli.js" },
    }),
  );
  await appendFile(path.join(packageDir, "bin", "cli.js"), "");
  const pinned = planMcpLaunch(installed("1.2.3"), options);
  assert.equal(pinned.command, "/opt/node/bin/node");
  assert.deepEqual(pinned.args, [path.join(packageDir, "bin", "cli.js")]);
  assert.equal(pinned.pin, undefined);
});
