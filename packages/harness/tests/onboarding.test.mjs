import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { onboardingStatePath } from "../dist/application/onboarding/state.js";
import {
  onboard,
  onboardStatus,
} from "../dist/interfaces/cli/onboard-command.js";

function fakeIO(interactive, answers = []) {
  const lines = [];
  return {
    lines,
    io: {
      interactive,
      say: (line) => lines.push(line),
      ask: async (_question, fallback) => answers.shift() ?? fallback,
    },
  };
}

function fakeSteps(calls) {
  const make = (id, optional) => ({
    id,
    title: id,
    optional,
    async run() {
      calls.push(id);
      return "done";
    },
  });
  return [make("a", false), make("b", true), make("c", false)];
}

async function withTempRoot(fn) {
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = await mkdtemp(
    path.join(os.tmpdir(), "ocean-onboard-"),
  );
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

test("completes once, then a second run is a no-op", async () => {
  await withTempRoot(async () => {
    const calls = [];
    await onboard({ io: fakeIO(true).io, steps: fakeSteps(calls) });
    assert.deepEqual(calls, ["a", "b", "c"]);
    const state = JSON.parse(await readFile(onboardingStatePath(), "utf8"));
    assert.deepEqual(state.steps, { a: "done", b: "done", c: "done" });
    const second = fakeIO(true);
    await onboard({ io: second.io, steps: fakeSteps(calls) });
    assert.deepEqual(calls, ["a", "b", "c"]);
    assert.match(second.lines.join("\n"), /complete/);
  });
});

test("non-interactive skips optional steps without prompting", async () => {
  await withTempRoot(async () => {
    const calls = [];
    await onboard({ io: fakeIO(false).io, steps: fakeSteps(calls) });
    assert.deepEqual(calls, ["a", "c"]);
    const state = JSON.parse(await readFile(onboardingStatePath(), "utf8"));
    assert.equal(state.steps.b, "skipped");
  });
});

test("an interrupted run resumes at the first pending step", async () => {
  await withTempRoot(async () => {
    const calls = [];
    const steps = fakeSteps(calls);
    steps[1].run = async () => {
      throw new Error("interrupted");
    };
    await assert.rejects(
      onboard({ io: fakeIO(true).io, steps }),
      /interrupted/,
    );
    assert.deepEqual(calls, ["a"]);
    await onboard({ io: fakeIO(true).io, steps: fakeSteps(calls) });
    assert.deepEqual(calls, ["a", "b", "c"]);
  });
});

test("a new step id runs alone; --reset redoes one step", async () => {
  await withTempRoot(async () => {
    const calls = [];
    await onboard({ io: fakeIO(true).io, steps: fakeSteps(calls) });
    calls.length = 0;
    const extended = [
      ...fakeSteps(calls),
      {
        id: "d",
        title: "d",
        optional: false,
        run: async () => {
          calls.push("d");
          return "done";
        },
      },
    ];
    await onboard({ io: fakeIO(true).io, steps: extended });
    assert.deepEqual(calls, ["d"]);
    calls.length = 0;
    await onboard({ io: fakeIO(true).io, steps: extended, reset: "b" });
    assert.deepEqual(calls, ["b"]);
    await assert.rejects(
      onboard({ io: fakeIO(true).io, steps: extended, reset: "nope" }),
      /Unknown onboarding step/,
    );
  });
});

test("status lists every step without running any", async () => {
  await withTempRoot(async () => {
    const calls = [];
    const steps = fakeSteps(calls);
    await onboard({ io: fakeIO(false).io, steps });
    calls.length = 0;
    const lines = [];
    await onboardStatus(steps, (line) => lines.push(line));
    assert.deepEqual(calls, []);
    assert.match(lines[0], /^done\s+a/);
    assert.match(lines[1], /^skipped\s+b/);
  });
});

test("the hook step prints the release entry first, the checkout only as fallback", async () => {
  const { buildSteps } = await import(
    "../dist/application/onboarding/steps.js"
  );
  const hooks = buildSteps({ setup: async () => {}, wrappers: {} }).find(
    (step) => step.id === "hooks",
  );
  const { io, lines } = fakeIO(true);
  await hooks.run(io);
  const text = lines.join("\n");
  assert.match(
    text,
    /ENTRY="\$HOME\/ocean\/bridge\/runtime\/release\/current\//,
  );
  assert.match(text, /\[ -f "\$ENTRY" \] \|\| ENTRY="\$HOME\/ocean\/kernel\//);
  assert.match(text, /node "\$ENTRY" client sync/);
});

// T-296 P3: the connect step over fake client operations — never a real client config.
function fakeClients(plans, hooks = [], native = []) {
  const calls = { apply: [], verify: [], applyHooks: [], applyNative: [] };
  return {
    calls,
    clients: {
      plan: async () => plans,
      apply: async (ids) => {
        calls.apply.push(ids);
        return {
          batch: "b1",
          results: ids.map((client) => ({ client, result: "written" })),
        };
      },
      verify: async (client) => {
        calls.verify.push(client);
        return { ok: client !== "codex", detail: "checked" };
      },
      hooks: async () => hooks,
      native: async () => native,
      applyNative: async (batch) => {
        calls.applyNative.push(batch);
        return native
          .filter((item) => item.status === "change")
          .map((item) => ({ client: item.client, result: "written" }));
      },
      applyHooks: async (batch) => {
        calls.applyHooks.push(batch);
        return hooks
          .filter((hook) => hook.status === "change")
          .map((hook) => ({ client: hook.client, result: "written" }));
      },
    },
  };
}

const plan = (client, status, extra = {}) => ({
  client,
  label: client,
  installed: true,
  status,
  ops: status === "change" ? [{ kind: "set", key: "ocean" }] : [],
  file: `~/.${client}`,
  reason: "why",
  fallback: "other way",
  ...extra,
});

async function connectStep(plans, hooks, native) {
  const { buildSteps } = await import(
    "../dist/application/onboarding/steps.js"
  );
  const fake = fakeClients(plans, hooks, native);
  const step = buildSteps({
    setup: async () => {},
    wrappers: {},
    clients: fake.clients,
  }).find((item) => item.id === "connect");
  return { step, calls: fake.calls };
}

const PLANS = [
  plan("cursor", "change"),
  plan("codex", "change"),
  plan("claude-code", "current"),
  plan("opencode", "manual", { snippet: '{"ocean":{}}' }),
  plan("chatgpt", "unsupported"),
  plan("ghost", "change", { installed: false }),
];

test("connect shows one review and applies every pending client on one yes", async () => {
  const { step, calls } = await connectStep(PLANS);
  const asked = [];
  const { io, lines } = fakeIO(true);
  io.ask = async (question, fallback) => {
    asked.push(question);
    return fallback;
  };
  assert.equal(await step.run(io), "done");
  assert.equal(asked.length, 1);
  assert.deepEqual(calls.apply, [["cursor", "codex"]]);
  assert.deepEqual(calls.verify, ["cursor", "codex"]);
  const text = lines.join("\n");
  assert.match(text, /claude-code\s+connected/);
  assert.match(text, /Hand edit for opencode .*\{"ocean":\{\}\}/);
  assert.match(text, /chatgpt\s+unsupported: why; fallback: other way/);
  assert.doesNotMatch(text, /ghost/);
  assert.match(text, /restore --batch b1/);
  assert.match(text, /cursor: PROVEN/);
  assert.match(text, /codex: NOT READY/);
  assert.match(text, /ocean_ping/);
});

test("connect writes nothing without a terminal or when declined", async () => {
  const quiet = await connectStep(PLANS);
  assert.equal(await quiet.step.run(fakeIO(false).io), "skipped");
  assert.deepEqual(quiet.calls.apply, []);
  const declined = await connectStep(PLANS);
  assert.equal(await declined.step.run(fakeIO(true, ["n"]).io), "skipped");
  assert.deepEqual(declined.calls.apply, []);
});

test("connect with nothing pending asks nothing and is done", async () => {
  const { step, calls } = await connectStep([plan("cursor", "current")]);
  const { io, lines } = fakeIO(true);
  io.ask = async () => assert.fail("must not prompt");
  assert.equal(await step.run(io), "done");
  assert.deepEqual(calls.apply, []);
  assert.match(lines.join("\n"), /already connected/);
});

test("connect puts session hooks in the same review and applies them under the same batch", async () => {
  const hooks = [
    { client: "codex", file: "~/.codex/hooks.json", status: "change" },
    {
      client: "claude-code",
      file: "~/.claude/settings.json",
      status: "current",
    },
    {
      client: "gemini",
      file: "~/.gemini/settings.json",
      status: "manual",
      reason: "not canonical",
      snippet: "hooks.SessionStart += {}",
    },
  ];
  const { step, calls } = await connectStep([plan("codex", "current")], hooks);
  const asked = [];
  const { io, lines } = fakeIO(true);
  io.ask = async (question, fallback) => {
    asked.push(question);
    return fallback;
  };
  assert.equal(await step.run(io), "done");
  assert.equal(asked.length, 1);
  assert.match(asked[0], /0 MCP entries, 1 session hooks, 0 native-memory/);
  assert.deepEqual(calls.apply, [[]]);
  assert.deepEqual(calls.applyHooks, ["b1"]);
  const text = lines.join("\n");
  assert.match(text, /codex session hook\s+will add a SessionStart hook/);
  assert.match(text, /claude-code session hook\s+present/);
  assert.match(
    text,
    /gemini session hook\s+hand edit needed \(not canonical\); add hooks/,
  );
  assert.match(text, /codex session hook: written/);
});

test("connect lists native-memory policies and applies the settable ones in the same batch", async () => {
  const native = [
    {
      client: "gemini",
      status: "change",
      file: "~/.gemini/settings.json",
      setting: 'tools.exclude += "save_memory"',
    },
    {
      client: "cursor",
      status: "toggle",
      reason: "turn off Memories in Cursor settings",
    },
    {
      client: "codex",
      status: "current",
      setting: "[memories] use_memories = false",
    },
  ];
  const { step, calls } = await connectStep(
    [plan("gemini", "current")],
    [],
    native,
  );
  const { io, lines } = fakeIO(true);
  assert.equal(await step.run(io), "done");
  assert.deepEqual(calls.applyNative, ["b1"]);
  const text = lines.join("\n");
  assert.match(text, /gemini native memory\s+will set tools\.exclude/);
  assert.match(text, /cursor native memory\s+you: turn off Memories/);
  assert.match(text, /codex native memory\s+governed/);
  assert.match(text, /gemini native memory: written/);
});
