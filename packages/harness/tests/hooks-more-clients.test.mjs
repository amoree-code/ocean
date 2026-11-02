import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { claudeSessionEndHook } from "@ocean/loop/hooks/session-end-hook.js";
import { sessionStartHookForClient } from "@ocean/loop/hooks/session-start-hook.js";
import { openSessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";
import {
  applyHooks,
  planHooks,
  restoreHooks,
} from "../dist/application/clients/hooks.js";
import {
  applyOpencodePlugin,
  OPENCODE_PLUGIN_FILE,
  opencodePluginSource,
  planOpencodePlugin,
  restoreOpencodePlugin,
} from "../dist/application/clients/opencode-plugin.js";
import { defaultSessionStoreFactory } from "../dist/composition/runtime.js";

// T-307: Qwen Code and Cursor hooks, and OpenCode's plugin, on a synthetic home only.
const ENTRY = {
  command: "/opt/test/node",
  args: ["/srv/ocean/packages/harness/dist/main.js", "mcp", "serve"],
};
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const QWEN = json({
  mcpServers: { ocean: { command: "x" } },
  hooks: {
    SessionStart: [
      { matcher: "*", hooks: [{ type: "command", command: "/usr/bin/true" }] },
    ],
  },
});
const CURSOR = json({
  version: 1,
  hooks: { stop: [{ command: "/usr/bin/true --event=stop" }] },
});

async function fixture({ cursor = CURSOR } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "ocean-hooks-t307-"));
  const home = path.join(base, "home");
  const bin = path.join(base, "bin");
  await mkdir(bin, { recursive: true });
  for (const name of ["qwen", "cursor-agent", "opencode"]) {
    await writeFile(path.join(bin, name), "#!/bin/sh\n");
    await chmod(path.join(bin, name), 0o755);
  }
  const files = { ".qwen/settings.json": QWEN };
  if (cursor !== null) files[".cursor/hooks.json"] = cursor;
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(home, relative)), { recursive: true });
    await writeFile(path.join(home, relative), content);
  }
  return {
    base,
    home,
    root: path.join(base, "ocean"),
    env: {
      home,
      pathDirs: [bin],
      appDirs: [],
      entry: ENTRY,
      platform: "linux",
    },
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

test("Qwen and Cursor get start and end hooks in their own shapes; restore is byte-identical", async () => {
  const { root, env, home } = await fixture();
  await withRoot(root, async () => {
    const plans = (await planHooks(env)).map(
      (plan) => `${plan.client}:${plan.event}:${plan.status}`,
    );
    assert.deepEqual(plans.sort(), [
      "cursor:SessionEnd:change",
      "cursor:SessionStart:change",
      "qwen:SessionEnd:change",
      "qwen:SessionStart:change",
    ]);
    const { batch } = await applyHooks({ env });
    const qwen = JSON.parse(await read(home, ".qwen/settings.json"));
    assert.deepEqual(qwen.mcpServers, { ocean: { command: "x" } });
    assert.equal(
      qwen.hooks.SessionStart.length,
      2,
      "the user's group stays first",
    );
    assert.deepEqual(qwen.hooks.SessionStart[1], {
      matcher: "startup|resume",
      hooks: [
        {
          type: "command",
          name: "ocean",
          command:
            "/opt/test/node /srv/ocean/packages/harness/dist/main.js hook session-start --client qwen --repair",
          timeout: 10_000,
        },
      ],
    });
    assert.match(
      qwen.hooks.SessionEnd[0].hooks[0].command,
      /hook session-end --client qwen$/,
    );
    const cursor = JSON.parse(await read(home, ".cursor/hooks.json"));
    assert.equal(cursor.version, 1);
    assert.deepEqual(cursor.hooks.stop, [
      { command: "/usr/bin/true --event=stop" },
    ]);
    assert.deepEqual(cursor.hooks.sessionStart, [
      {
        command:
          "/opt/test/node /srv/ocean/packages/harness/dist/main.js hook session-start --client cursor --repair",
      },
    ]);
    assert.match(
      cursor.hooks.sessionEnd[0].command,
      /hook session-end --client cursor$/,
    );
    assert.ok(
      (await planHooks(env)).every((plan) => plan.status === "current"),
      "a second plan finds every hook in place",
    );
    assert.deepEqual((await applyHooks({ env })).results, []);
    const undone = await restoreHooks({ batch, env });
    assert.deepEqual(undone.conflicts, []);
    assert.equal(await read(home, ".qwen/settings.json"), QWEN);
    assert.equal(await read(home, ".cursor/hooks.json"), CURSOR);
  });
});

test("a missing Cursor hooks file is created with version 1 and emptied again on restore", async () => {
  const { root, env, home } = await fixture({ cursor: null });
  await withRoot(root, async () => {
    const { batch } = await applyHooks({ env });
    const cursor = JSON.parse(await read(home, ".cursor/hooks.json"));
    assert.equal(cursor.version, 1);
    assert.equal(cursor.hooks.sessionStart.length, 1);
    await restoreHooks({ batch, env });
    assert.deepEqual(JSON.parse(await read(home, ".cursor/hooks.json")), {});
  });
});

test("the OpenCode plugin is written once, journaled, left alone when not Ocean's, and removed on restore", async () => {
  const { root, env, home } = await fixture();
  await withRoot(root, async () => {
    assert.equal((await planOpencodePlugin(env))[0].status, "change");
    const { batch, results } = await applyOpencodePlugin({ env });
    assert.deepEqual(results, [{ client: "opencode", result: "written" }]);
    const source = await read(home, OPENCODE_PLUGIN_FILE);
    assert.equal(source, opencodePluginSource(env));
    assert.match(source, /"hook", "session-start", "--client", "opencode"/);
    assert.equal((await planOpencodePlugin(env))[0].status, "current");
    assert.deepEqual(await restoreOpencodePlugin({ batch, env }), {
      restored: ["opencode:plugin"],
      conflicts: [],
    });
    await assert.rejects(read(home, OPENCODE_PLUGIN_FILE), /ENOENT/);
    await writeFile(
      path.join(home, OPENCODE_PLUGIN_FILE),
      "export const Mine = 1;\n",
    );
    const plan = (await planOpencodePlugin(env))[0];
    assert.equal(plan.status, "manual");
    assert.deepEqual((await applyOpencodePlugin({ env })).results, []);
    assert.equal(
      await read(home, OPENCODE_PLUGIN_FILE),
      "export const Mine = 1;\n",
    );
  });
});

test("the OpenCode plugin adds the start line to each session's system prompt, asking once per session", async () => {
  const { base, env } = await fixture();
  const fake = path.join(base, "fake-ocean.mjs");
  const calls = path.join(base, "calls.log");
  await writeFile(
    fake,
    `import { appendFileSync } from "node:fs";
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  appendFileSync(${JSON.stringify(calls)}, input + "\\n");
  const { cwd } = JSON.parse(input);
  console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: "ocean=1 project=demo cwd=" + cwd } }));
});
`,
  );
  const plugin = path.join(base, "ocean-plugin.mjs");
  await writeFile(
    plugin,
    opencodePluginSource({
      ...env,
      entry: { command: process.execPath, args: [fake] },
    }),
  );
  const { OceanContext } = await import(pathToFileURL(plugin).href);
  const hooks = await OceanContext({ directory: "/work/demo" });
  const transform = hooks["experimental.chat.system.transform"];
  const first = { system: ["base"] };
  await transform({ sessionID: "s1" }, first);
  const second = { system: ["base"] };
  await transform({ sessionID: "s1" }, second);
  assert.deepEqual(first.system, [
    "base",
    "ocean=1 project=demo cwd=/work/demo",
  ]);
  assert.deepEqual(second.system, first.system);
  const asked = (await readFile(calls, "utf8")).trim().split("\n");
  assert.equal(asked.length, 1, "one start line per session");
  assert.deepEqual(JSON.parse(asked[0]), {
    session_id: "s1",
    cwd: "/work/demo",
  });
});

test("Cursor's start hook reads workspace_roots and answers additional_context, keeping nothing else", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-cursor-start-"));
  await withRoot(root, async () => {
    const result = await sessionStartHookForClient("cursor", {
      session_id: "c1",
      workspace_roots: [os.tmpdir()],
      // Built at run time so no address sits in the source.
      user_email: ["someone", "example.com"].join("@"),
    });
    assert.deepEqual(Object.keys(result), ["additional_context"]);
    assert.match(result.additional_context, /^ocean=1 project=/);
    assert.doesNotMatch(result.additional_context, /example\.com/);
    const qwen = await sessionStartHookForClient("qwen", { cwd: os.tmpdir() });
    assert.match(qwen.hookSpecificOutput.additionalContext, /^ocean=1 /);
  });
});

test("Gemini, Qwen and Cursor session ends are recorded from metadata only, never their transcripts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-end-t307-"));
  const transcript = path.join(root, "transcript.jsonl");
  await writeFile(
    transcript,
    `${JSON.stringify({ type: "user", message: { content: "private question" } })}\n`,
  );
  await withRoot(root, async () => {
    for (const client of ["gemini", "qwen", "cursor"]) {
      const payload =
        client === "cursor"
          ? {
              session_id: `${client}-1`,
              workspace_roots: [root],
              transcript_path: transcript,
            }
          : {
              session_id: `${client}-1`,
              cwd: root,
              transcript_path: transcript,
            };
      await claudeSessionEndHook(payload, defaultSessionStoreFactory, client);
    }
    const store = await openSessionStore();
    try {
      for (const client of ["gemini", "qwen", "cursor"]) {
        const saved = store.get(`${client}-1`);
        assert.equal(saved.provider, client);
        assert.equal(saved.workingDirectory, root);
        const events = store
          .listEvents(`${client}-1`)
          .map((event) => event.type);
        assert.equal(events.includes("user_input"), false, client);
        assert.ok(events.includes("process_exit"), client);
      }
    } finally {
      store.close();
    }
  });
});
