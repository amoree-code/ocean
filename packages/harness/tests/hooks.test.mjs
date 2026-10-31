import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyClients,
  readJournal,
  restoreClients,
} from "../dist/application/clients/clients.js";
import {
  applyHooks,
  hookCommand,
  planHooks,
  restoreHooks,
} from "../dist/application/clients/hooks.js";

// Synthetic home only (T-296 P3b): hook files shaped like the real ones, other tools' hooks kept.
const ENTRY = {
  command: "/opt/test/node",
  args: ["/release/current/packages/harness/dist/main.js", "mcp", "serve"],
};
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const ADS = (client) => ({
  hooks: [
    {
      type: "command",
      command: `/opt/ads/bin/adshook ${client} idle --event=SessionStart`,
      timeout: 5,
    },
  ],
});
const CODEX_HOOKS = json({
  hooks: {
    SessionStart: [
      {
        matcher: "startup|resume",
        hooks: [
          { type: "command", command: "echo 'CAVEMAN MODE'", timeout: 5 },
        ],
      },
      ADS("codex"),
    ],
    UserPromptSubmit: [ADS("codex")],
  },
});
const GEMINI_SETTINGS = json({
  security: { auth: { selectedType: "oauth-personal" } },
  mcpServers: { other: { command: "x" } },
  hooks: { SessionStart: [{ matcher: "*", ...ADS("gemini") }] },
});
// Claude's settings are not in canonical form (key spacing), like the real file.
const CLAUDE_SETTINGS = '{"hooks": {"SessionStart": []}}\n';

async function fixtureHome({ claude = CLAUDE_SETTINGS } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "ocean-hooks-"));
  const home = path.join(base, "home");
  const root = path.join(base, "ocean");
  const bin = path.join(base, "bin");
  await mkdir(bin, { recursive: true });
  for (const name of ["claude", "codex", "gemini"]) {
    await writeFile(path.join(bin, name), "#!/bin/sh\n");
    await chmod(path.join(bin, name), 0o755);
  }
  const files = {
    ".codex/hooks.json": CODEX_HOOKS,
    ".gemini/settings.json": GEMINI_SETTINGS,
    ".claude/settings.json": claude,
  };
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(home, relative)), { recursive: true });
    await writeFile(path.join(home, relative), content);
  }
  return {
    home,
    root,
    env: { home, pathDirs: [bin], appDirs: [], entry: ENTRY },
  };
}

async function withRoot(root, run) {
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

const read = (home, relative) => readFile(path.join(home, relative), "utf8");
const byClient = (plans) =>
  Object.fromEntries(plans.map((plan) => [plan.client, plan.status]));

test("plan: a missing hook is a change, a non-canonical file a manual step with the group", async () => {
  const { root, env } = await fixtureHome();
  await withRoot(root, async () => {
    const plans = await planHooks(env);
    assert.deepEqual(byClient(plans), {
      "claude-code": "manual",
      codex: "change",
      gemini: "change",
    });
    const claude = plans.find((plan) => plan.client === "claude-code");
    assert.match(claude.reason, /canonical/);
    assert.match(claude.snippet, /hook session-start --client claude --repair/);
  });
});

test("an Ocean hook that already runs (bootstrap or shim) counts as present and is left alone", async () => {
  const bootstrap = json({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command:
                "$HOME/ocean/bridge/integrations/claude-code/hooks/ocean-session-bootstrap",
            },
          ],
        },
      ],
    },
  });
  const { root, env, home } = await fixtureHome({ claude: bootstrap });
  await withRoot(root, async () => {
    assert.equal(byClient(await planHooks(env))["claude-code"], "current");
    await applyHooks({ env });
    assert.equal(await read(home, ".claude/settings.json"), bootstrap);
  });
});

test("apply appends one group after the user's own, keeps every other byte, and is idempotent", async () => {
  const { root, env, home } = await fixtureHome();
  await withRoot(root, async () => {
    const { results } = await applyHooks({ env });
    assert.deepEqual(results, [
      { client: "codex", result: "written" },
      { client: "gemini", result: "written" },
    ]);
    const codex = JSON.parse(await read(home, ".codex/hooks.json"));
    const original = JSON.parse(CODEX_HOOKS);
    assert.deepEqual(
      codex.hooks.SessionStart.slice(0, 2),
      original.hooks.SessionStart,
    );
    assert.deepEqual(
      codex.hooks.UserPromptSubmit,
      original.hooks.UserPromptSubmit,
    );
    assert.equal(codex.hooks.SessionStart.length, 3);
    assert.equal(
      codex.hooks.SessionStart[2].hooks[0].command,
      "/opt/test/node /release/current/packages/harness/dist/main.js hook session-start --client codex --repair",
    );
    const gemini = JSON.parse(await read(home, ".gemini/settings.json"));
    assert.deepEqual(gemini.security, JSON.parse(GEMINI_SETTINGS).security);
    assert.deepEqual(gemini.mcpServers, { other: { command: "x" } });
    assert.equal(gemini.hooks.SessionStart[1].hooks[0].timeout, 10_000);
    assert.match(
      gemini.hooks.SessionStart[1].hooks[0].command,
      /--client gemini/,
    );
    assert.equal(await read(home, ".claude/settings.json"), CLAUDE_SETTINGS);
    assert.deepEqual((await applyHooks({ env })).results, []);
    assert.deepEqual(byClient(await planHooks(env)), {
      "claude-code": "manual",
      codex: "current",
      gemini: "current",
    });
  });
});

test("restore of the batch returns entries and hooks byte-identical", async () => {
  const { root, env, home } = await fixtureHome();
  await withRoot(root, async () => {
    const { batch } = await applyClients({ clients: ["gemini", "codex"], env });
    await applyHooks({ env, batch });
    assert.notEqual(await read(home, ".gemini/settings.json"), GEMINI_SETTINGS);
    const entries = await restoreClients({ batch, env });
    const hooks = await restoreHooks({ batch, env });
    assert.equal(entries.batch, batch);
    assert.deepEqual(hooks, {
      restored: ["gemini:hook", "codex:hook"],
      conflicts: [],
    });
    assert.equal(await read(home, ".gemini/settings.json"), GEMINI_SETTINGS);
    assert.equal(await read(home, ".codex/hooks.json"), CODEX_HOOKS);
    // Each hook is undone once, by restoreHooks — never noted by restoreClients as well.
    const undone = (await readJournal()).filter(
      (entry) => entry.op === "hook-add" && entry.restoreOf === batch,
    );
    assert.equal(undone.length, 2);
  });
});

test("a missing hooks file is created 0600; restore removes the keys the add created", async () => {
  const { root, env, home } = await fixtureHome();
  await withRoot(root, async () => {
    const { rm } = await import("node:fs/promises");
    await rm(path.join(home, ".codex/hooks.json"));
    const { batch } = await applyHooks({ env, clients: ["codex"] });
    const file = path.join(home, ".codex/hooks.json");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(
      JSON.parse(await readFile(file, "utf8")).hooks.SessionStart.length,
      1,
    );
    await restoreHooks({ batch, env });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {});
  });
});

test("a hook group the user changed after apply is a conflict on restore and left alone", async () => {
  const { root, env, home } = await fixtureHome();
  await withRoot(root, async () => {
    const { batch } = await applyHooks({ env, clients: ["codex"] });
    const file = path.join(home, ".codex/hooks.json");
    const edited = JSON.parse(await readFile(file, "utf8"));
    edited.hooks.SessionStart[2].hooks[0].timeout = 30;
    await writeFile(file, json(edited));
    const result = await restoreHooks({ batch, env });
    assert.deepEqual(result, { restored: [], conflicts: ["codex:hook"] });
    assert.equal(await readFile(file, "utf8"), json(edited));
  });
});

test("hooks are refused for an engine in a temporary directory; paths with spaces are quoted", async () => {
  const { root, env, home } = await fixtureHome();
  await withRoot(root, async () => {
    const scratch = {
      ...env,
      entry: {
        command: "/opt/test/node",
        args: [path.join(os.tmpdir(), "wt/main.js")],
      },
    };
    await assert.rejects(
      applyHooks({ env: scratch, durable: true }),
      /Refusing to add session hooks: .*temporary directory/,
    );
    assert.equal(await read(home, ".codex/hooks.json"), CODEX_HOOKS);
    assert.equal(
      hookCommand(
        { ...env, entry: { command: "/My Apps/node", args: ["/o'k/main.js"] } },
        "codex",
      ),
      `'/My Apps/node' '/o'\\''k/main.js' hook session-start --client codex --repair`,
    );
  });
});
