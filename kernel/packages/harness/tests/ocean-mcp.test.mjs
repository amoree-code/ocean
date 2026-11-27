import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reindexBrain } from "@ocean/brain/brain/brain-reindex.js";
import {
  PROJECTS_DIR,
  STORE_DIR,
  SYSTEM_DIR,
} from "@ocean/core/shared/paths.js";
import { SessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";
import { handleOceanMcpRequest } from "@ocean/services/infrastructure/mcp/ocean-server.js";
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

test("Ocean MCP exposes provider-neutral tools without Obsidian", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-mcp-no-obsidian-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    const listed = await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      [
        "brain_search",
        "brain_read",
        "memory_read",
        "memory_write",
        "memory_propose",
        "ocean_context",
        "ocean_tools",
        "ocean_call",
      ],
    );
    const status = await handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "ocean_status", arguments: {} },
    });
    assert.match(status.result.content[0].text, /"name":"Ocean"/);
    const retired = await handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "legacy_status", arguments: {} },
    });
    assert.equal(retired.error?.message, "Unknown MCP tool");
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});

test("ocean_task_get reads a task from the named project, by prefix or by old id", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-mcp-task-project-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    const lab = path.join(root, PROJECTS_DIR, "lab");
    await mkdir(path.join(lab, "tasks", "LB-001"), { recursive: true });
    await writeFile(
      path.join(lab, "project.json"),
      JSON.stringify({ name: "lab", paths: [], prefix: "LB", nextTask: 2 }),
    );
    await writeFile(
      path.join(lab, "tasks", "LB-001", "task.md"),
      "---\nid: LB-001\nlegacyId: T-300\ntitle: Lab task\nstate: active\n---\n\n## Objective\n\nDo it.\n",
    );
    const get = async (args) => {
      const response = await handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ocean_task_get", arguments: args },
      });
      return response.error
        ? { error: response.error.message }
        : JSON.parse(response.result.content[0].text);
    };
    const byPrefix = await get({ taskId: "LB-001" });
    assert.equal(byPrefix.id, "LB-001");
    assert.equal(byPrefix.project, "lab");
    assert.equal((await get({ taskId: "T-300", project: "lab" })).id, "LB-001");
    assert.match(
      (await get({ taskId: "T-300", project: "ocean" })).error,
      /not a task/,
    );
    assert.match(
      (await get({ taskId: "LB-001", project: "ocean" })).error,
      /belongs to lab/,
    );
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});

test("brain_search and brain_neighbors take project/cwd and show only that project's memory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-mcp-scope-"));
  const repoA = await mkdtemp(path.join(os.tmpdir(), "ocean-mcp-repo-a-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await mkdir(path.join(root, PROJECTS_DIR, "a"), { recursive: true });
    await writeFile(
      path.join(root, PROJECTS_DIR, "a", "project.json"),
      JSON.stringify({ name: "a", paths: [repoA] }),
    );
    const store = path.join(root, STORE_DIR.memory);
    await mkdir(store, { recursive: true });
    for (const [name, scope] of [
      ["g", "global"],
      ["a", "project:a"],
      ["b", "project:b"],
    ])
      await writeFile(
        path.join(store, `${name}.md`),
        `---\nid: rec-${name}\ntitle: Rec ${name}\nscope: ${scope}\n---\n\nzebrafood [[g]] [[a]] [[b]]\n`,
      );
    await reindexBrain({ root, indexPort: defaultBrainIndexPort });
    const listed = await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    // brain_neighbors sits in the brain-extra group: ocean_tools hands over its schema.
    const extra = JSON.parse(
      (
        await handle({
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "ocean_tools", arguments: { open: ["brain-extra"] } },
        })
      ).result.content[0].text,
    );
    for (const name of ["brain_search", "brain_neighbors"]) {
      const schema = [...listed.result.tools, ...extra.tools].find(
        (tool) => tool.name === name,
      ).inputSchema;
      assert.equal(schema.properties.project.type, "string");
      assert.equal(schema.properties.cwd.type, "string");
      assert.equal(schema.additionalProperties, false);
    }
    const call = async (name, args) => {
      const response = await handle({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name, arguments: args },
      });
      return response.error
        ? { error: response.error.message }
        : JSON.parse(response.result.content[0].text);
    };
    const hits = async (args) =>
      (await call("brain_search", { query: "zebrafood", ...args })).results
        .map((hit) => hit.id)
        .sort();
    assert.deepEqual(await hits({ cwd: repoA }), ["rec-a", "rec-g"]);
    assert.deepEqual(await hits({ project: "b" }), ["rec-b", "rec-g"]);
    assert.deepEqual(await hits({ project: "a", cwd: repoA }), [
      "rec-a",
      "rec-g",
    ]);
    // An unbound cwd sees global only.
    assert.deepEqual(await hits({ cwd: os.tmpdir() }), ["rec-g"]);
    assert.match(
      (await call("brain_search", { query: "x", project: "../x" })).error,
      /invalid project id/,
    );
    const neighbors = await call("brain_neighbors", {
      id: "rec-g",
      cwd: repoA,
    });
    assert.deepEqual(neighbors.neighbors.map((n) => n.id).sort(), ["rec-a"]);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});

test("read-only session tools do not initialize a missing session database", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-mcp-readonly-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    const response = await handle({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "ocean_session_get",
        arguments: { sessionId: "missing" },
      },
    });
    assert.ok(response.error);
    await assert.rejects(
      access(path.join(root, SYSTEM_DIR, "sessions", "sessions.sqlite")),
    );
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});

test("Ocean MCP exposes bounded resources and prompt templates", async () => {
  const listedResources = await handle({
    jsonrpc: "2.0",
    id: 3,
    method: "resources/list",
  });
  assert.deepEqual(
    listedResources.result.resources.map((resource) => resource.uri),
    ["ocean://status", "ocean://profiles", "ocean://tasks", "ocean://handoffs"],
  );
  const resource = await handle({
    jsonrpc: "2.0",
    id: 4,
    method: "resources/read",
    params: { uri: "ocean://status" },
  });
  assert.match(resource.result.contents[0].text, /"name": "Ocean"/);
  for (const uri of ["ocean://tasks"]) {
    const tasks = await handle({
      jsonrpc: "2.0",
      id: 7,
      method: "resources/read",
      params: { uri },
    });
    assert.equal(tasks.error, undefined, uri);
    assert.equal(tasks.result.contents[0].uri, uri);
    assert.ok(Array.isArray(JSON.parse(tasks.result.contents[0].text).tasks));
  }
  const unknown = await handle({
    jsonrpc: "2.0",
    id: 8,
    method: "resources/read",
    params: { uri: "tasks" },
  });
  assert.ok(unknown.error);
  const retired = await handle({
    jsonrpc: "2.0",
    id: 10,
    method: "resources/read",
    params: { uri: "legacy://tasks" },
  });
  assert.ok(retired.error);
  const init = await handle({
    jsonrpc: "2.0",
    id: 9,
    method: "initialize",
  });
  assert.equal(init.result.serverInfo.name, "ocean");
  assert.equal(init.result.serverInfo.title, "Ocean");
  const listedPrompts = await handle({
    jsonrpc: "2.0",
    id: 5,
    method: "prompts/list",
  });
  assert.deepEqual(
    listedPrompts.result.prompts.map((prompt) => prompt.name),
    ["ocean_review_workspace", "ocean_review_task"],
  );
  const prompt = await handle({
    jsonrpc: "2.0",
    id: 6,
    method: "prompts/get",
    params: { name: "ocean_review_task", arguments: { task: "T-1" } },
  });
  assert.match(prompt.result.messages[0].content.text, /T-1/);
});

test("ocean_tasks_list follows the folder it is given, else lists every project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-mcp-tasks-"));
  const repo = await mkdtemp(path.join(os.tmpdir(), "ocean-mcp-shop-repo-"));
  const task = async (project, id) => {
    const dir = path.join(root, PROJECTS_DIR, project, "tasks", id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "task.md"),
      `---\nid: ${id}\ntitle: ${project} ${id}\nstate: active\n---\n`,
    );
  };
  await task("ocean", "T-001");
  await task("shop", "T-101");
  await writeFile(
    path.join(root, PROJECTS_DIR, "shop", "project.json"),
    JSON.stringify({ name: "shop", paths: [repo] }),
  );
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  const call = async (args) => {
    const response = await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ocean_tasks_list", arguments: args },
    });
    return JSON.parse(response.result.content[0].text);
  };
  const ids = (found) => found.tasks.map((t) => `${t.project}/${t.id}`);
  try {
    const own = await call({ cwd: repo });
    assert.equal(own.scope, "project");
    assert.deepEqual(ids(own), ["shop/T-101"]);
    const elsewhere = await call({
      cwd: await mkdtemp(path.join(os.tmpdir(), "ocean-mcp-nowhere-")),
    });
    assert.equal(elsewhere.scope, "all");
    assert.deepEqual(ids(elsewhere), ["ocean/T-001", "shop/T-101"]);
    assert.match(elsewhere.note, /not an Ocean project/);
    assert.deepEqual(ids(await call({ project: "ocean" })), ["ocean/T-001"]);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});

test("ocean_handoffs_list filters by project", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ocean-mcp-handoff-project-"),
  );
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await mkdir(path.join(root, SYSTEM_DIR, "sessions"), { recursive: true });
    const store = new SessionStore();
    for (const [id, project] of [
      ["h-shop", "shop"],
      ["h-ocean", "ocean"],
      ["h-none", null],
    ])
      store.saveHandoff({
        handoffId: id,
        title: id,
        state: "paused",
        projectId: project,
      });
    store.close();
    const list = async (args) => {
      const response = await handle({
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: { name: "ocean_handoffs_list", arguments: args },
      });
      return JSON.parse(response.result.content[0].text)
        .handoffs.map((h) => h.handoffId)
        .sort();
    };
    assert.deepEqual(await list({}), ["h-none", "h-ocean", "h-shop"]);
    assert.deepEqual(await list({ project: "shop" }), ["h-shop"]);
    assert.deepEqual(await list({ project: "nowhere" }), []);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});

// T-339 P2 (after T-338 P5): eight core tools are listed to every client; a group opens with
// OCEAN_MCP_TOOLS=all, when ocean_profile_get names ocean-ops, through ocean_tools, or when the
// prompt hook's selection file for the folder names it — each tells the client with
// list_changed. A tool left off the list still answers tools/call and ocean_call.
test("Ocean MCP lists core tools, opens groups, and keeps every tool callable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-mcp-groups-"));
  const serve = (env) => {
    const child = spawn(
      process.execPath,
      [path.resolve("dist/main.js"), "mcp", "serve"],
      {
        cwd: root,
        env: { ...process.env, OCEAN_ROOT: root, ...env },
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const messages = [];
    let buffer = "";
    const waiters = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        messages.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      for (const waiter of waiters.splice(0)) waiter();
    });
    const request = async (id, method, params = {}) => {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
      while (!messages.some((message) => message.id === id))
        await new Promise((resolve) => waiters.push(resolve));
      return messages.find((message) => message.id === id);
    };
    return { child, messages, request };
  };
  const names = (reply) => reply.result.tools.map((tool) => tool.name);

  const plain = serve({ OCEAN_MCP_TOOLS: "" });
  try {
    const init = await plain.request(1, "initialize", {
      clientInfo: { name: "groups-test" },
    });
    assert.equal(init.result.capabilities.tools.listChanged, true);
    const core = names(await plain.request(2, "tools/list"));
    assert.equal(core.length, 8);
    assert.ok(!core.includes("ocean_ping"));
    const bytes = Buffer.byteLength(
      JSON.stringify((await plain.request(20, "tools/list")).result.tools),
    );
    assert.ok(bytes <= 6_000, `core tools/list is ${bytes} bytes`);
    const ping = await plain.request(3, "tools/call", {
      name: "ocean_ping",
      arguments: {},
    });
    assert.equal(ping.result.structuredContent.ok, true);
    await plain.request(4, "tools/call", {
      name: "ocean_profile_get",
      arguments: { name: "ocean-ops" },
    });
    assert.ok(
      plain.messages.some(
        (message) => message.method === "notifications/tools/list_changed",
      ),
    );
    const opened = names(await plain.request(5, "tools/list"));
    assert.equal(opened.length, 25);
    assert.ok(opened.includes("ocean_ping"));
    // ocean_call runs an unlisted tool; it never calls itself.
    const viaCall = await plain.request(6, "tools/call", {
      name: "ocean_call",
      arguments: { name: "people_lookup", arguments: { name: "nobody" } },
    });
    assert.ok(viaCall.result, JSON.stringify(viaCall.error));
    const loop = await plain.request(7, "tools/call", {
      name: "ocean_call",
      arguments: { name: "ocean_call", arguments: {} },
    });
    assert.match(loop.error.message, /cannot call itself/);
    // ocean_tools opens a group and returns its schemas.
    const before = plain.messages.length;
    const tasks = await plain.request(8, "tools/call", {
      name: "ocean_tools",
      arguments: { open: ["tasks"] },
    });
    assert.deepEqual(
      tasks.result.structuredContent.tools.map((tool) => tool.name).sort(),
      ["ocean_task_get", "ocean_tasks_list"],
    );
    assert.ok(
      plain.messages
        .slice(before)
        .some(
          (message) => message.method === "notifications/tools/list_changed",
        ),
    );
    assert.equal(names(await plain.request(9, "tools/list")).length, 27);
    const unknown = await plain.request(10, "tools/call", {
      name: "ocean_tools",
      arguments: { open: ["nope"] },
    });
    assert.match(unknown.error.message, /Unknown tool group/);
  } finally {
    plain.child.kill();
  }

  // A client the probe found never re-lists (Codex) is pointed at ocean_call.
  const codex = serve({ OCEAN_MCP_TOOLS: "" });
  try {
    await codex.request(1, "initialize", {
      clientInfo: { name: "codex-mcp-client" },
    });
    const opened = await codex.request(2, "tools/call", {
      name: "ocean_tools",
      arguments: { open: ["tasks"] },
    });
    assert.match(
      opened.result.structuredContent.call,
      /does not re-list.*ocean_call/,
    );
  } finally {
    codex.child.kill();
  }

  // The hook writes the folder's selection file; a running server opens what it names.
  const watched = serve({ OCEAN_MCP_TOOLS: "" });
  try {
    await watched.request(1, "initialize", {
      clientInfo: { name: "groups-test" },
    });
    assert.equal(names(await watched.request(2, "tools/list")).length, 8);
    const { writeToolSelection } = await import(
      "@ocean/core/shared/tool-groups.js"
    );
    const previous = process.env.OCEAN_ROOT;
    process.env.OCEAN_ROOT = root;
    try {
      await writeToolSelection(await realpath(root), {
        primary: "base",
        secondary: [],
        groups: ["people"],
      });
    } finally {
      if (previous === undefined) delete process.env.OCEAN_ROOT;
      else process.env.OCEAN_ROOT = previous;
    }
    const deadline = Date.now() + 5_000;
    while (
      !watched.messages.some(
        (message) => message.method === "notifications/tools/list_changed",
      ) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    const after = names(await watched.request(3, "tools/list"));
    assert.ok(after.includes("people_lookup"), after.join());
  } finally {
    watched.child.kill();
  }

  const all = serve({ OCEAN_MCP_TOOLS: "all" });
  try {
    await all.request(1, "initialize", { clientInfo: { name: "groups-test" } });
    assert.equal(names(await all.request(2, "tools/list")).length, 33);
  } finally {
    all.child.kill();
  }
});
