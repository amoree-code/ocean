import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleOceanMcpRequest } from "../dist/infrastructure/mcp/ocean-server.js";
import { SessionStore } from "../dist/infrastructure/persistence/session-store.js";
import { PROJECTS_DIR, SYSTEM_DIR } from "../dist/paths.js";

test("Ocean MCP exposes provider-neutral read-only tools without Obsidian", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-mcp-no-obsidian-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    const listed = await handleOceanMcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      [
        "ocean_status",
        "ocean_doctor",
        "ocean_profiles_list",
        "ocean_tasks_list",
        "ocean_task_get",
        "ocean_handoffs_list",
        "ocean_handoff_get",
        "ocean_session_get",
        "ocean_session_summary",
        "ocean_session_events",
        "ocean_session_promote",
        "brain_search",
        "brain_read",
        "brain_neighbors",
      ],
    );
    const status = await handleOceanMcpRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "ocean_status", arguments: {} },
    });
    assert.match(status.result.content[0].text, /"name":"Ocean"/);
    const retired = await handleOceanMcpRequest({
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
      const response = await handleOceanMcpRequest({
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

test("read-only session tools do not initialize a missing session database", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-mcp-readonly-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    const response = await handleOceanMcpRequest({
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
  const listedResources = await handleOceanMcpRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "resources/list",
  });
  assert.deepEqual(
    listedResources.result.resources.map((resource) => resource.uri),
    ["ocean://status", "ocean://profiles", "ocean://tasks", "ocean://handoffs"],
  );
  const resource = await handleOceanMcpRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "resources/read",
    params: { uri: "ocean://status" },
  });
  assert.match(resource.result.contents[0].text, /"name": "Ocean"/);
  for (const uri of ["ocean://tasks"]) {
    const tasks = await handleOceanMcpRequest({
      jsonrpc: "2.0",
      id: 7,
      method: "resources/read",
      params: { uri },
    });
    assert.equal(tasks.error, undefined, uri);
    assert.equal(tasks.result.contents[0].uri, uri);
    assert.ok(Array.isArray(JSON.parse(tasks.result.contents[0].text).tasks));
  }
  const unknown = await handleOceanMcpRequest({
    jsonrpc: "2.0",
    id: 8,
    method: "resources/read",
    params: { uri: "tasks" },
  });
  assert.ok(unknown.error);
  const retired = await handleOceanMcpRequest({
    jsonrpc: "2.0",
    id: 10,
    method: "resources/read",
    params: { uri: "legacy://tasks" },
  });
  assert.ok(retired.error);
  const init = await handleOceanMcpRequest({
    jsonrpc: "2.0",
    id: 9,
    method: "initialize",
  });
  assert.equal(init.result.serverInfo.name, "ocean");
  const listedPrompts = await handleOceanMcpRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "prompts/list",
  });
  assert.deepEqual(
    listedPrompts.result.prompts.map((prompt) => prompt.name),
    ["ocean_review_workspace", "ocean_review_task"],
  );
  const prompt = await handleOceanMcpRequest({
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
    const response = await handleOceanMcpRequest({
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
      const response = await handleOceanMcpRequest({
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
