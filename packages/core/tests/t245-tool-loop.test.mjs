// T-245 Phase 6 — the bounded tool loop for completion clients. The model is a scripted fake;
// the tools are the real executor against a temporary workspace.
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "../dist/application/runs/run-agent.js";
import { runToolLoop } from "../dist/application/runs/tool-loop.js";
import { createAgentRuntime } from "../dist/composition/runtime.js";
import { selectProfileClient } from "../dist/domain/profiles/profile.js";
import { validateProfile } from "../dist/domain/profiles/profile-validator.js";
import { buildExecutionPlan } from "../dist/domain/runs/execution-plan.js";
import { SessionStore } from "../dist/infrastructure/persistence/session-store.js";
import { executeAgentTool } from "../dist/infrastructure/process/agent-tool-executor.js";
import { SYSTEM_DIR } from "../dist/paths.js";

const unixOnly = process.platform === "win32" ? test.skip : test;
const SECRET_CONTENT = "do-not-send-this-file";

const profileJson = (overrides = {}) => ({
  schemaVersion: 2,
  name: "deepseek-agent",
  role: "developer",
  defaultClient: "deepseek",
  clients: {
    deepseek: { enabled: true, model: "deepseek-chat", toolLoop: true },
  },
  governance: {
    allowedPaths: ["src"],
    allowedCommands: [],
    writePolicy: "none",
    sandbox: { mode: "read-only", network: "provider-only" },
  },
  memory: { enabled: false, scope: "disabled" },
  ...overrides,
});

const writable = (commands = []) =>
  profileJson({
    governance: {
      allowedPaths: ["src"],
      allowedCommands: commands,
      writePolicy: "workspace",
      sandbox: { mode: "workspace-write", network: "provider-only" },
    },
  });

async function withWorkspace(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "t245-loop-"));
  const cwd = path.join(root, "work");
  await mkdir(path.join(cwd, "src", "nested"), { recursive: true });
  await mkdir(path.join(cwd, ".git"), { recursive: true });
  await mkdir(path.join(root, "outside"), { recursive: true });
  await writeFile(path.join(cwd, "src", "a.txt"), "alpha");
  await writeFile(path.join(cwd, "src", ".env"), SECRET_CONTENT);
  await writeFile(path.join(cwd, ".git", "config"), SECRET_CONTENT);
  await writeFile(path.join(cwd, "top.txt"), SECRET_CONTENT);
  await writeFile(path.join(root, "outside", "secret.txt"), SECRET_CONTENT);
  try {
    return await fn({ root, cwd });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function planFor(raw, cwd, writeAllowed = false) {
  return buildExecutionPlan(selectProfileClient(validateProfile(raw)), {
    cwd,
    supportedTransports: ["cli", "openai-compatible-api"],
    writeAllowed,
    enforceableNetwork: ["provider-only"],
  });
}

const call = (name, args, id = `${name}-${Math.random()}`) => ({
  id,
  type: "function",
  function: {
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
  },
});

// Replies in order; each is a list of tool calls or a final text. Records every request.
function scripted(replies) {
  const requests = [];
  const chat = async (request) => {
    requests.push(
      structuredClone({ messages: request.messages, tools: request.tools }),
    );
    const next = replies[Math.min(requests.length, replies.length) - 1];
    const reply = typeof next === "function" ? await next(request) : next;
    return Array.isArray(reply)
      ? {
          message: { role: "assistant", content: null, tool_calls: reply },
          model: "m",
          usage: null,
          id: null,
        }
      : {
          message: { role: "assistant", content: reply },
          model: "m",
          usage: null,
          id: null,
        };
  };
  return { chat, requests };
}

const loop = (plan, chat, extra = {}) =>
  runToolLoop({
    plan,
    prompt: "do the task",
    chat,
    executeTool: executeAgentTool,
    ...extra,
  });

const toolMessages = (requests) =>
  requests.at(-1).messages.filter((message) => message.role === "tool");
const eventsOf = (result, type) =>
  result.events.filter((event) => event.data.type === type);

test("a read-only loop offers only read tools and returns the final answer", async () => {
  await withWorkspace(async ({ cwd }) => {
    const { chat, requests } = scripted([
      [call("read_file", { path: "src/a.txt" }, "c1")],
      "the file says alpha",
    ]);
    const result = await loop(planFor(profileJson(), cwd), chat);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(
      requests[0].tools.map((tool) => tool.function.name),
      ["read_file", "list_directory"],
    );
    assert.deepEqual(toolMessages(requests), [
      { role: "tool", tool_call_id: "c1", content: "alpha" },
    ]);
    const done = eventsOf(result, "completion")[0].data;
    assert.equal(done.text, "the file says alpha");
    assert.equal(done.toolCalls, 1);
    assert.equal(eventsOf(result, "tool_result")[0].data.bytes, 5);
    // Tool output is sent to the model but not stored in events.
    assert.ok(!JSON.stringify(result.events).includes('"alpha"'));
  });
});

unixOnly(
  "every path escape is denied and nothing outside the allowed paths is sent",
  async () => {
    await withWorkspace(async ({ root, cwd }) => {
      await symlink(path.join(root, "outside"), path.join(cwd, "src", "link"));
      const attempts = [
        { path: "../outside/secret.txt" },
        { path: path.join(root, "outside", "secret.txt") },
        { path: "src/../../outside/secret.txt" },
        { path: "src/link/secret.txt" },
        { path: "top.txt" },
        { path: "src/.env" },
        { path: ".git/config" },
      ];
      const { chat, requests } = scripted([
        attempts.map((args, index) => call("read_file", args, `p${index}`)),
        [call("list_directory", { path: "src" }, "ls")],
        "done",
      ]);
      const result = await loop(planFor(profileJson(), cwd), chat);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(eventsOf(result, "tool_denied").length, attempts.length);
      const sent = JSON.stringify(requests.at(-1).messages);
      assert.ok(!sent.includes(SECRET_CONTENT));
      const listing = toolMessages(requests).find(
        (message) => message.tool_call_id === "ls",
      ).content;
      assert.ok(!listing.includes(".env"));
      assert.match(listing, /a\.txt/);
    });
  },
);

test("there is no command tool, even for a writable profile that lists commands", async () => {
  await withWorkspace(async ({ cwd }) => {
    const { chat, requests } = scripted([
      [call("run_command", { command: "node", args: ["-e", "1"] }, "r")],
      "done",
    ]);
    const result = await loop(planFor(writable(["node"]), cwd, true), chat);
    assert.equal(result.exitCode, 0);
    assert.ok(
      !requests[0].tools.some((tool) => tool.function.name === "run_command"),
    );
    assert.equal(
      eventsOf(result, "tool_denied")[0].data.reason,
      "unknown tool: run_command",
    );
  });
});

unixOnly(
  "a symlink inside an allowed path cannot reach .env or .git, read or write",
  async () => {
    await withWorkspace(async ({ cwd }) => {
      await mkdir(path.join(cwd, ".git", "hooks"), { recursive: true });
      const plan = profileJson({
        governance: {
          allowedPaths: ["."],
          allowedCommands: [],
          writePolicy: "workspace",
          sandbox: { mode: "workspace-write", network: "provider-only" },
        },
      });
      await symlink(path.join(cwd, "src", ".env"), path.join(cwd, "notes.txt"));
      await symlink(path.join(cwd, ".git"), path.join(cwd, "gitdir"));
      const { chat, requests } = scripted([
        [
          call("read_file", { path: "notes.txt" }, "a"),
          call("read_file", { path: "gitdir/config" }, "b"),
          call(
            "write_file",
            { path: "gitdir/hooks/pre-commit", content: "#!/bin/sh" },
            "c",
          ),
          call("write_file", { path: "notes.txt", content: "x" }, "d"),
          call("read_file", { path: ".Git/config" }, "e"),
          call(
            "write_file",
            { path: ".GIT/hooks/post-merge", content: "#!/bin/sh" },
            "f",
          ),
          call("read_file", { path: "src/.ENV" }, "g"),
        ],
        "done",
      ]);
      const result = await loop(planFor(plan, cwd, true), chat);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(eventsOf(result, "tool_denied").length, 7);
      assert.ok(
        !JSON.stringify(requests.at(-1).messages).includes(SECRET_CONTENT),
      );
      await assert.rejects(
        readFile(path.join(cwd, ".git", "hooks", "pre-commit")),
        {
          code: "ENOENT",
        },
      );
      await assert.rejects(
        readFile(path.join(cwd, ".git", "hooks", "post-merge")),
        {
          code: "ENOENT",
        },
      );
      assert.equal(
        await readFile(path.join(cwd, "src", ".env"), "utf8"),
        SECRET_CONTENT,
      );
    });
  },
);

test("a file holding a known credential shape is refused, not sent or redacted", async () => {
  await withWorkspace(async ({ cwd }) => {
    const key = ["sk", "ant", "abcdefghijklmnop12345"].join("-");
    await writeFile(path.join(cwd, "src", "config.json"), `{"key": "${key}"}`);
    const { chat, requests } = scripted([
      [call("read_file", { path: "src/config.json" }, "k")],
      "done",
    ]);
    const result = await loop(planFor(profileJson(), cwd), chat);
    assert.equal(
      eventsOf(result, "tool_denied")[0].data.reason,
      "file appears to contain a credential",
    );
    assert.ok(!JSON.stringify(requests).includes(key));
  });
});

test("absolute paths and directories are not read", async () => {
  await withWorkspace(async ({ cwd }) => {
    const { chat } = scripted([
      [
        call("read_file", { path: path.join(cwd, "src", "a.txt") }, "abs"),
        call("read_file", { path: "src/nested" }, "dir"),
      ],
      "done",
    ]);
    const result = await loop(planFor(profileJson(), cwd), chat);
    assert.deepEqual(
      eventsOf(result, "tool_denied").map((event) => event.data.reason),
      ["path must be relative to the working directory", "not a file"],
    );
  });
});

test("the run contract narrows the offered tools", async () => {
  await withWorkspace(async ({ cwd }) => {
    const { chat, requests } = scripted([
      [call("write_file", { path: "src/x.txt", content: "x" }, "w")],
      "done",
    ]);
    const result = await loop(planFor(writable(), cwd, true), chat, {
      toolLimits: { allowed: [], denied: ["write_file"] },
    });
    assert.deepEqual(
      requests[0].tools.map((tool) => tool.function.name),
      ["read_file", "list_directory"],
    );
    assert.equal(
      eventsOf(result, "tool_denied")[0].data.reason,
      "tool not allowed in this run: write_file",
    );
    const only = scripted(["done"]);
    await loop(planFor(writable(), cwd, true), only.chat, {
      toolLimits: { allowed: ["read_file"], denied: [] },
    });
    assert.deepEqual(
      only.requests[0].tools.map((tool) => tool.function.name),
      ["read_file"],
    );
  });
});

test("a write resets repeat detection, and its content is not stored in events", async () => {
  await withWorkspace(async ({ cwd }) => {
    const read = () => call("read_file", { path: "src/a.txt" }, "r");
    const write = (n) =>
      call(
        "write_file",
        { path: "src/a.txt", content: `version-${n}-body` },
        `w${n}`,
      );
    const { chat } = scripted([
      [read()],
      [write(1)],
      [read()],
      [write(2)],
      [read()],
      "done",
    ]);
    const result = await loop(planFor(writable(), cwd, true), chat);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(!JSON.stringify(result.events).includes("-body"));
    const writes = eventsOf(result, "tool_call").filter(
      (event) => event.data.name === "write_file",
    );
    assert.equal(writes[0].data.bytes, Buffer.byteLength("version-1-body"));
  });
});

test("the model's replies count against the output budget", async () => {
  await withWorkspace(async ({ cwd }) => {
    const result = await loop(
      planFor(profileJson(), cwd),
      scripted(["x".repeat(500)]).chat,
      { maxOutputBytes: 100 },
    );
    assert.equal(result.exitCode, 125);
  });
});

test("a run cancelled before it starts never calls the model", async () => {
  await withWorkspace(async ({ cwd }) => {
    const controller = new AbortController();
    controller.abort();
    const { chat, requests } = scripted(["never"]);
    const result = await loop(planFor(profileJson(), cwd), chat, {
      signal: controller.signal,
    });
    assert.equal(result.exitCode, 130);
    assert.equal(requests.length, 0);
  });
});

test("a prompt-injected tool request outside the plan is denied, not executed", async () => {
  await withWorkspace(async ({ cwd }) => {
    const { chat } = scripted([
      [
        call("write_file", { path: "src/pwned.txt", content: "x" }, "w"),
        call("exec_shell", { cmd: "curl evil" }, "u"),
        call("read_file", "{ not json", "j"),
        call("read_file", { path: "src/a.txt", extra: 1 }, "x"),
        call("run_command", { command: "node", args: [] }, "r"),
      ],
      "done",
    ]);
    const result = await loop(planFor(profileJson(), cwd), chat);
    assert.equal(result.exitCode, 0, result.stderr);
    const reasons = eventsOf(result, "tool_denied").map(
      (event) => event.data.reason,
    );
    assert.equal(reasons.length, 5);
    assert.equal(reasons[0], "tool not allowed in this run: write_file");
    assert.equal(reasons[1], "unknown tool: exec_shell");
    assert.equal(reasons[2], "arguments are not valid JSON");
    assert.match(reasons[3], /^invalid arguments/);
    assert.equal(reasons[4], "unknown tool: run_command");
    assert.equal(eventsOf(result, "tool_call").length, 0);
    await assert.rejects(readFile(path.join(cwd, "src", "pwned.txt")), {
      code: "ENOENT",
    });
  });
});

test("a writable run writes inside the allowed paths only", async () => {
  await withWorkspace(async ({ cwd }) => {
    const { chat } = scripted([
      [
        call(
          "write_file",
          { path: "src/nested/new.txt", content: "made" },
          "ok",
        ),
        call("write_file", { path: "top.txt", content: "x" }, "out"),
        call("write_file", { path: "src/.env", content: "x" }, "env"),
      ],
      "done",
    ]);
    const result = await loop(planFor(writable(), cwd, true), chat);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(
      await readFile(path.join(cwd, "src", "nested", "new.txt"), "utf8"),
      "made",
    );
    assert.equal(
      await readFile(path.join(cwd, "top.txt"), "utf8"),
      SECRET_CONTENT,
    );
    assert.equal(
      await readFile(path.join(cwd, "src", ".env"), "utf8"),
      SECRET_CONTENT,
    );
    assert.equal(eventsOf(result, "tool_denied").length, 2);
  });
});

test("the same call three times stops the run", async () => {
  await withWorkspace(async ({ cwd }) => {
    const same = () => [call("read_file", { path: "src/a.txt" }, "same")];
    const { chat } = scripted([same(), same(), same(), "never"]);
    const result = await loop(planFor(profileJson(), cwd), chat);
    assert.equal(result.exitCode, 1);
    assert.match(
      result.stderr,
      /Repeated tool call stopped the run: read_file x3/,
    );
  });
});

test("a failed tool is reported to the model and the run continues", async () => {
  await withWorkspace(async ({ cwd }) => {
    const { chat, requests } = scripted([
      [call("read_file", { path: "src/missing.txt" }, "m")],
      "recovered",
    ]);
    const result = await loop(planFor(profileJson(), cwd), chat);
    assert.equal(result.exitCode, 0);
    assert.equal(eventsOf(result, "tool_result")[0].data.ok, false);
    assert.match(toolMessages(requests)[0].content, /^error: .*ENOENT/);
    assert.equal(eventsOf(result, "completion")[0].data.text, "recovered");
  });
});

test("cancellation stops a run mid-turn", async () => {
  await withWorkspace(async ({ cwd }) => {
    const controller = new AbortController();
    const { chat } = scripted([
      (request) =>
        new Promise((_, reject) => {
          request.signal.addEventListener("abort", () =>
            reject(request.signal.reason),
          );
          setTimeout(() => controller.abort(), 20);
        }),
    ]);
    const result = await loop(planFor(profileJson(), cwd), chat, {
      signal: controller.signal,
    });
    assert.equal(result.exitCode, 130);
    assert.match(result.stderr, /cancelled/);
  });
});

test("every budget ends the run: iterations, tool calls, output, deadline", async () => {
  await withWorkspace(async ({ cwd }) => {
    const plan = planFor(profileJson(), cwd);
    let n = 0;
    const iterations = await loop(
      plan,
      scripted([
        () => [call("list_directory", { path: `src/./${"./".repeat(n++)}` })],
      ]).chat,
    );
    assert.equal(iterations.exitCode, 1);
    assert.match(iterations.stderr, /Iteration budget exhausted \(20\)/);

    const many = (k) =>
      Array.from({ length: 16 }, (_, i) =>
        call("list_directory", { path: `src/${"./".repeat(k * 16 + i)}` }),
      );
    let k = 0;
    const calls = await loop(plan, scripted([() => many(k++)]).chat);
    assert.equal(calls.exitCode, 1);
    assert.match(calls.stderr, /Tool call budget exhausted \(50\)/);

    const output = await loop(
      plan,
      scripted([[call("read_file", { path: "src/a.txt" })], "x"]).chat,
      { maxOutputBytes: 3 },
    );
    assert.equal(output.exitCode, 125);

    const slow = await loop(
      plan,
      scripted([
        (request) =>
          new Promise((_, reject) =>
            request.signal.addEventListener("abort", () =>
              reject(request.signal.reason),
            ),
          ),
      ]).chat,
      { timeoutMs: 50 },
    );
    assert.equal(slow.exitCode, 124);
  });
});

test("toolLoop is only for completion clients", () => {
  assert.throws(
    () =>
      validateProfile({
        name: "p",
        role: "r",
        defaultClient: "claude",
        clients: { claude: { enabled: true, model: "sonnet", toolLoop: true } },
      }),
    /toolLoop is for completion clients/,
  );
});

// ---- through ocean run ---------------------------------------------------------------------

async function withProfileRoot(raw, fn) {
  return withWorkspace(async ({ root, cwd }) => {
    await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
    await writeFile(
      path.join(root, SYSTEM_DIR, "profiles", `${raw.name}.json`),
      JSON.stringify(raw),
    );
    const previous = process.env.OCEAN_ROOT;
    process.env.OCEAN_ROOT = root;
    try {
      return await fn({ root, cwd });
    } finally {
      if (previous === undefined) delete process.env.OCEAN_ROOT;
      else process.env.OCEAN_ROOT = previous;
    }
  });
}

const contract = (sessionId, cwd, approved) => ({
  runId: `run-${sessionId}`,
  sessionId,
  profile: "deepseek-agent",
  workingDirectory: cwd,
  allowedTools: [],
  deniedTools: [],
  stopConditions: ["done"],
  approval: { required: true, approved },
  budget: { timeoutMs: 30_000, maxAttempts: 1, maxOutputBytes: 100_000 },
});

test("a writable tool loop needs an approved run contract; with one it may write", async () => {
  await withProfileRoot(writable(), async ({ root, cwd }) => {
    const { chat, requests } = scripted([
      [
        call(
          "write_file",
          { path: "src/out.txt", content: "via ocean run" },
          "w",
        ),
      ],
      "written",
    ]);
    const runtime = createAgentRuntime({ chat });
    await assert.rejects(
      runAgent(
        {
          sessionId: "denied",
          profileName: "deepseek-agent",
          prompt: "write",
          cwd,
          runContract: contract("denied", cwd, false),
        },
        runtime,
      ),
      /approved run contract/,
    );
    assert.equal(requests.length, 0);
    const session = await runAgent(
      {
        sessionId: "approved",
        profileName: "deepseek-agent",
        prompt: "write",
        cwd,
        runContract: contract("approved", cwd, true),
      },
      runtime,
    );
    assert.equal(session.status, "completed");
    assert.deepEqual(
      requests[0].tools.map((tool) => tool.function.name),
      ["read_file", "list_directory", "write_file"],
    );
    assert.equal(
      await readFile(path.join(cwd, "src", "out.txt"), "utf8"),
      "via ocean run",
    );
    const store = new SessionStore(
      path.join(root, SYSTEM_DIR, "sessions", "sessions.sqlite"),
    );
    try {
      const events = store.listEvents("approved");
      const plan = JSON.parse(
        events.find((event) => event.type === "execution_plan").data,
      ).plan;
      assert.equal(plan.toolLoop, true);
      assert.equal(plan.sandbox.mode, "workspace-write");
      const types = events
        .filter((event) => event.type === "json")
        .map((event) => JSON.parse(event.data).type);
      assert.deepEqual(types, ["tool_call", "tool_result", "completion"]);
    } finally {
      store.close();
    }
  });
});

test("a tool-loop profile without an approved contract runs read-only", async () => {
  await withProfileRoot(profileJson(), async ({ cwd }) => {
    const { chat, requests } = scripted(["just text"]);
    const session = await runAgent(
      { profileName: "deepseek-agent", prompt: "look", cwd },
      createAgentRuntime({ chat }),
    );
    assert.equal(session.status, "completed");
    assert.deepEqual(
      requests[0].tools.map((tool) => tool.function.name),
      ["read_file", "list_directory"],
    );
  });
});

test("credential shapes the first review found unrefused are refused; ordinary code is not", async () => {
  await withWorkspace(async ({ cwd }) => {
    const shapes = {
      "aws.txt": `key ${["AKIA", "ABCDEFGHIJKLMNOP"].join("")}`,
      "stripe.txt": ["sk", "live", "abcdefghijklmnop1234"].join("_"),
      "npm.txt": `${"npm"}_${"a".repeat(18)}${"B".repeat(18)}`,
      "gitlab.txt": `${"glpat"}-${"x".repeat(20)}`,
      "github.txt": `${"gho"}_${"y".repeat(36)}`,
      "env.txt": `DB_PASS=${"hunter2hunter2"}`,
      "yaml.txt": `client_secret: "${"z".repeat(12)}"`,
    };
    for (const [file, content] of Object.entries(shapes))
      await writeFile(path.join(cwd, "src", file), content);
    await writeFile(
      path.join(cwd, "src", "code.ts"),
      "const token = getToken();\nexport const password = input.value;\n",
    );
    await writeFile(path.join(cwd, "src", "credentials.json"), "{}");
    await writeFile(path.join(cwd, "src", "main.tfstate"), "{}");
    const { chat, requests } = scripted([
      [
        ...Object.keys(shapes).map((file) =>
          call("read_file", { path: `src/${file}` }, file),
        ),
        call("read_file", { path: "src/credentials.json" }, "cj"),
        call("read_file", { path: "src/main.tfstate" }, "tf"),
        call("read_file", { path: "src/code.ts" }, "code"),
      ],
      "done",
    ]);
    const result = await loop(planFor(profileJson(), cwd), chat);
    assert.equal(
      eventsOf(result, "tool_denied").length,
      Object.keys(shapes).length + 2,
    );
    const sent = JSON.stringify(requests.at(-1).messages);
    for (const content of Object.values(shapes))
      assert.ok(!sent.includes(content), content.slice(0, 8));
    assert.match(sent, /getToken/);
  });
});
