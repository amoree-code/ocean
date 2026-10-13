// T-245 Phase 4 — OpenAI-compatible completion clients (DeepSeek, OpenRouter) over fetch,
// exercised against a local fake server. No real provider is called.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "../dist/application/runs/run-agent.js";
import { createAgentRuntime } from "../dist/composition/runtime.js";
import { validateProfile } from "../dist/domain/profiles/profile-validator.js";
import { SessionStore } from "../dist/infrastructure/persistence/session-store.js";
import { createCompletionExecutor } from "../dist/infrastructure/providers/openai-compatible.js";
import { SYSTEM_DIR } from "../dist/paths.js";

const SECRET = "fake-credential-for-tests";

// Each handler answers one request in order; the last one repeats.
async function withServer(handlers, fn) {
  const hits = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      hits.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: body ? JSON.parse(body) : null,
      });
      handlers[Math.min(hits.length, handlers.length) - 1](response);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/chat/completions`;
  try {
    return await fn({ url, hits });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const json =
  (status, body, headers = {}) =>
  (response) => {
    response.writeHead(status, {
      "content-type": "application/json",
      ...headers,
    });
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  };

const ok = json(
  200,
  {
    id: "cmpl-1",
    model: "deepseek-chat-upstream",
    usage: { prompt_tokens: 3, completion_tokens: 2 },
    choices: [{ message: { role: "assistant", content: "hello back" } }],
  },
  {
    "x-request-id": "req-42",
    "x-ratelimit-remaining-requests": "99",
  },
);

function executor(url, options = {}) {
  const delays = [];
  const run = createCompletionExecutor({
    endpoints: { deepseek: url, openrouter: url },
    env: { DEEPSEEK_API_KEY: SECRET, OPENROUTER_API_KEY: SECRET },
    sleep: async (ms) => {
      delays.push(ms);
    },
    ...options,
  });
  return { run, delays };
}

const request = (overrides = {}) => ({
  provider: "deepseek",
  model: "deepseek-chat",
  prompt: "hello",
  ...overrides,
});

test("a completion is sent with the plan's model and normalized into one event", async () => {
  await withServer([ok], async ({ url, hits }) => {
    const seen = [];
    const result = await executor(url).run(
      request({ temperature: 0.3, onEvent: (event) => seen.push(event) }),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].method, "POST");
    assert.equal(hits[0].headers.authorization, `Bearer ${SECRET}`);
    assert.deepEqual(hits[0].body, {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 8192,
      stream: false,
      temperature: 0.3,
    });
    assert.deepEqual(seen, result.events);
    assert.equal(result.events.length, 1);
    const { data } = result.events[0];
    assert.equal(data.type, "completion");
    assert.equal(data.text, "hello back");
    assert.equal(data.model, "deepseek-chat-upstream");
    assert.equal(data.id, "cmpl-1");
    assert.equal(data.requestId, "req-42");
    assert.equal(data.status, 200);
    assert.deepEqual(data.usage, { prompt_tokens: 3, completion_tokens: 2 });
    assert.deepEqual(data.rateLimit, {
      "x-ratelimit-remaining-requests": "99",
    });
    assert.equal(typeof data.durationMs, "number");
    assert.ok(!JSON.stringify(result).includes(SECRET));
  });
});

test("a missing credential fails before any request and names only the variable", async () => {
  await withServer([ok], async ({ url, hits }) => {
    const result = await executor(url, { env: {} }).run(request());
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Missing credential: set DEEPSEEK_API_KEY/);
    assert.equal(hits.length, 0);
    const openrouter = await executor(url, { env: {} }).run(
      request({ provider: "openrouter" }),
    );
    assert.match(openrouter.stderr, /OPENROUTER_API_KEY/);
  });
});

test("authentication and validation failures are never retried", async () => {
  for (const status of [400, 401, 403])
    await withServer(
      [json(status, { error: { message: "nope" } })],
      async ({ url, hits }) => {
        const result = await executor(url).run(request({ maxAttempts: 3 }));
        assert.equal(result.exitCode, 1);
        assert.match(result.stderr, new RegExp(`HTTP ${status}`));
        assert.equal(hits.length, 1);
        assert.ok(!result.stderr.includes(SECRET));
      },
    );
});

test("429 is retried after Retry-After, within the attempt budget", async () => {
  await withServer(
    [json(429, { error: "slow down" }, { "retry-after": "2" }), ok],
    async ({ url, hits }) => {
      const { run, delays } = executor(url);
      const result = await run(request({ maxAttempts: 3 }));
      assert.equal(result.exitCode, 0);
      assert.equal(hits.length, 2);
      assert.deepEqual(delays, [2000]);
      assert.equal(result.events[0].data.type, "completion_retry");
      assert.equal(result.events[0].data.status, 429);
      assert.equal(result.events[1].data.attempt, 2);
    },
  );
});

test("5xx is retried with bounded exponential backoff until the budget runs out", async () => {
  await withServer([json(503, "down")], async ({ url, hits }) => {
    const { run, delays } = executor(url);
    const result = await run(request({ maxAttempts: 3 }));
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /HTTP 503/);
    assert.equal(hits.length, 3);
    assert.deepEqual(delays, [500, 1000]);
  });
  await withServer(
    [json(500, "x", { "retry-after": "3600" }), ok],
    async ({ url }) => {
      const { run, delays } = executor(url);
      await run(request({ maxAttempts: 2 }));
      assert.deepEqual(delays, [8000]);
    },
  );
});

test("without an attempt budget a transient failure is not retried", async () => {
  await withServer([json(503, "down"), ok], async ({ url, hits }) => {
    const result = await executor(url).run(request());
    assert.equal(result.exitCode, 1);
    assert.equal(hits.length, 1);
  });
});

test("the deadline aborts a slow response and a pending backoff", async () => {
  await withServer(
    [(response) => setTimeout(() => ok(response), 2_000)],
    async ({ url }) => {
      const result = await executor(url).run(request({ timeoutMs: 100 }));
      assert.equal(result.exitCode, 124);
      assert.match(result.stderr, /timed out/);
    },
  );
  await withServer(
    [json(503, "down", { "retry-after": "5" })],
    async ({ url, hits }) => {
      // The real sleep: the deadline must cut the 5 s backoff short.
      const run = createCompletionExecutor({
        endpoints: { deepseek: url, openrouter: url },
        env: { DEEPSEEK_API_KEY: SECRET },
      });
      const started = Date.now();
      const result = await run(request({ timeoutMs: 200, maxAttempts: 3 }));
      assert.equal(result.exitCode, 124);
      assert.ok(Date.now() - started < 2_000);
      assert.equal(hits.length, 1);
    },
  );
});

test("a response over the output budget is cut off, not buffered", async () => {
  await withServer(
    [
      json(200, {
        choices: [{ message: { content: "x".repeat(10_000) } }],
      }),
    ],
    async ({ url }) => {
      const result = await executor(url).run(
        request({ maxOutputBytes: 1_000 }),
      );
      assert.equal(result.exitCode, 125);
      assert.match(result.stderr, /Output budget exceeded/);
    },
  );
});

test("a malformed or empty completion is an error", async () => {
  for (const [body, pattern] of [
    ["{ not json", /not JSON/],
    [{ choices: [] }, /no choices\[0\]\.message\.content/],
    [{ choices: [{ message: { content: 7 } }] }, /no choices/],
  ])
    await withServer([json(200, body)], async ({ url }) => {
      const result = await executor(url).run(request());
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, pattern);
    });
});

test("a redirect is refused, so the credential never reaches another host", async () => {
  await withServer([ok], async ({ url: elsewhere, hits: elsewhereHits }) => {
    await withServer(
      [
        (response) => {
          response.writeHead(307, { location: elsewhere });
          response.end();
        },
      ],
      async ({ url }) => {
        const result = await executor(url).run(request());
        assert.equal(result.exitCode, 1);
        assert.match(result.stderr, /Completion request failed/);
        assert.equal(elsewhereHits.length, 0);
      },
    );
  });
});

test("a profile cannot choose the endpoint or the credential variable", () => {
  const profile = validateProfile({
    schemaVersion: 2,
    name: "api",
    role: "r",
    defaultClient: "deepseek",
    clients: {
      deepseek: {
        enabled: true,
        model: "deepseek-chat",
        baseUrl: "https://attacker.example",
        credentialEnv: "ANTHROPIC_API_KEY",
      },
    },
    governance: { sandbox: { mode: "read-only", network: "provider-only" } },
  });
  assert.equal("baseUrl" in profile.clients.deepseek, false);
  assert.equal("credentialEnv" in profile.clients.deepseek, false);
});

test("ocean run with a completion profile goes through the HTTP transport end to end", async () => {
  await withServer([ok], async ({ url, hits }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "t245-http-"));
    await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
    await writeFile(
      path.join(root, SYSTEM_DIR, "profiles", "deepseek-coder.json"),
      JSON.stringify({
        schemaVersion: 2,
        name: "deepseek-coder",
        role: "developer",
        defaultClient: "deepseek",
        clients: {
          deepseek: { enabled: true, model: "deepseek-chat", temperature: 0 },
        },
        governance: {
          allowedCommands: ["pnpm"],
          sandbox: { mode: "read-only", network: "provider-only" },
        },
        memory: { enabled: true, scope: "profile" },
      }),
    );
    const previous = process.env.OCEAN_ROOT;
    process.env.OCEAN_ROOT = root;
    try {
      let spawned = false;
      const session = await runAgent(
        { profileName: "deepseek-coder", prompt: "explain", cwd: root },
        createAgentRuntime({
          executeProvider: async () => {
            spawned = true;
            return { exitCode: 0, events: [], stderr: "" };
          },
          executeCompletion: executor(url).run,
        }),
      );
      assert.equal(spawned, false);
      assert.equal(session.status, "completed");
      assert.equal(session.provider, "deepseek");
      assert.equal(hits.length, 1);
      assert.equal(hits[0].body.model, "deepseek-chat");
      assert.equal(hits[0].body.temperature, 0);
      assert.match(hits[0].body.messages[0].content, /explain/);
      const store = new SessionStore(
        path.join(root, SYSTEM_DIR, "sessions", "sessions.sqlite"),
      );
      try {
        const events = store.listEvents(session.sessionId);
        const plan = JSON.parse(
          events.find((event) => event.type === "execution_plan").data,
        ).plan;
        assert.equal(plan.transport, "openai-compatible-api");
        assert.equal(plan.provider, "deepseek");
        const completion = JSON.parse(
          events.find((event) => event.type === "json").data,
        );
        assert.equal(completion.text, "hello back");
        assert.ok(!events.some((event) => event.data.includes(SECRET)));
      } finally {
        store.close();
      }
    } finally {
      if (previous === undefined) delete process.env.OCEAN_ROOT;
      else process.env.OCEAN_ROOT = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
