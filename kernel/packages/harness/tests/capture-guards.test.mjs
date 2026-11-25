import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  claudeSessionEndHook,
  isHeadlessRun,
} from "@ocean/loop/hooks/session-end-hook.js";
import { runSessionFacts } from "@ocean/loop/hooks/session-facts-hook.js";
import { openSessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";
import {
  codexHookTrust,
  trustedHookKeys,
} from "../dist/application/clients/hook-trust.js";
import { defaultSessionStoreFactory } from "../dist/composition/runtime.js";

// T-336: headless runs are never captured, Codex hook trust is reported, and no record writer
// takes a project from a folder name.

const cli = path.resolve("dist/main.js");

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

const sessionMeta = (originator) =>
  JSON.stringify({
    timestamp: "2026-11-25T10:00:00.000Z",
    type: "session_meta",
    payload: {
      id: "s",
      cwd: "/tmp/x",
      originator,
      source: originator === "codex_exec" ? "exec" : "cli",
      base_instructions: { text: "x".repeat(200_000) },
    },
  });

const codexTurn = (role, text) =>
  JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  });

async function rollout(root, name, originator) {
  const file = path.join(root, `${name}.jsonl`);
  await writeFile(
    file,
    `${[sessionMeta(originator), codexTurn("user", "I'm based in Baghdad."), codexTurn("assistant", "Noted.")].join("\n")}\n`,
  );
  return file;
}

test("a codex_exec rollout is headless; an interactive one, a Claude transcript or a missing file is not", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-headless-"));
  const exec = await rollout(root, "exec", "codex_exec");
  const tui = await rollout(root, "tui", "codex_cli_rs");
  assert.equal(await isHeadlessRun({ transcript_path: exec }, "codex"), true);
  assert.equal(await isHeadlessRun({ transcript_path: tui }, "codex"), false);
  assert.equal(await isHeadlessRun({ transcript_path: exec }, "claude"), false);
  assert.equal(
    await isHeadlessRun(
      { transcript_path: path.join(root, "gone.jsonl") },
      "codex",
    ),
    false,
  );
  assert.equal(await isHeadlessRun({}, "codex"), false);
});

test("a codex_exec session end records nothing and fact capture never calls the model", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-headless-end-"));
  const exec = await rollout(root, "exec", "codex_exec");
  const tui = await rollout(root, "tui", "codex_cli_rs");
  await withRoot(root, async () => {
    await claudeSessionEndHook(
      { session_id: "exec-1", transcript_path: exec, cwd: root },
      defaultSessionStoreFactory,
      "codex",
    );
    await claudeSessionEndHook(
      { session_id: "tui-1", transcript_path: tui, cwd: root },
      defaultSessionStoreFactory,
      "codex",
    );
    let calls = 0;
    const completer = () => async () => {
      calls += 1;
      return '{"facts":[]}';
    };
    const facts = await runSessionFacts(
      { session_id: "exec-1", transcript_path: exec, cwd: root },
      defaultSessionStoreFactory,
      "codex",
      completer,
      { enabled: async () => true },
    );
    assert.equal(facts.status, "headless");
    assert.equal(calls, 0);
    const store = await openSessionStore();
    try {
      assert.equal(store.get("exec-1"), null);
      assert.equal(store.get("tui-1")?.provider, "codex");
    } finally {
      store.close();
    }
  });
});

test("inside Ocean's own model call (FACTS_CALL) a session-end hook records nothing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-facts-call-"));
  const transcript = path.join(root, "t.jsonl");
  await writeFile(
    transcript,
    `${JSON.stringify({ type: "user", message: { content: "extract facts" } })}\n`,
  );
  const result = spawnSync(
    process.execPath,
    [cli, "hook", "session-end", "--client", "claude"],
    {
      input: JSON.stringify({
        session_id: "facts-call-1",
        transcript_path: transcript,
        cwd: root,
      }),
      env: { ...process.env, OCEAN_ROOT: root, OCEAN_FACTS_CALL: "1" },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  await withRoot(root, async () => {
    const store = await openSessionStore();
    try {
      assert.equal(store.get("facts-call-1"), null);
    } finally {
      store.close();
    }
  });
});

test("Codex hook trust: each Ocean hook is matched to its trust key; other hooks are ignored", () => {
  const file = "/srv/test/.codex/hooks.json";
  const hooks = JSON.stringify({
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: "echo other tool" }] },
        {
          matcher: "startup|resume",
          hooks: [
            {
              type: "command",
              command: "/x/ocean hook session-start --client codex",
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: "command",
              command: "/x/ocean hook session-end --client codex",
            },
          ],
        },
      ],
    },
  });
  const config = [
    "[hooks.state]",
    "",
    `[hooks.state."${file}:session_start:0:0"]`,
    'trusted_hash = "sha256:aa"',
    "",
    `[hooks.state."${file}:session_start:1:0"]`,
    'trusted_hash = "sha256:bb"',
    "",
    "[features]",
    "hooks = true",
  ].join("\n");
  assert.deepEqual(codexHookTrust(hooks, config, file), [
    {
      client: "codex",
      event: "SessionStart",
      key: `${file}:session_start:1:0`,
      trusted: true,
    },
    {
      client: "codex",
      event: "SessionEnd",
      key: `${file}:session_end:0:0`,
      trusted: false,
    },
  ]);
  // The inline-table shape, a literal-string key, and a key with escapes are read too.
  const keys = trustedHookKeys(
    [
      "[hooks.state]",
      `"a:session_end:0:0" = { trusted_hash = "sha256:cc" }`,
      `[hooks.state.'b:session_end:0:0']`,
      'trusted_hash = "sha256:dd"',
      String.raw`[hooks.state."D:\\work\\.codex\\hooks.json:session_end:0:0"]`,
      'trusted_hash = "sha256:ee"',
      "[other]",
      'trusted_hash = "sha256:ff"',
    ].join("\n"),
  );
  assert.deepEqual(
    [...keys].sort(),
    [
      String.raw`D:\work\.codex\hooks.json:session_end:0:0`,
      "a:session_end:0:0",
      "b:session_end:0:0",
    ].sort(),
  );
  assert.deepEqual(codexHookTrust("not json", config, file), []);
});

// Every module that writes a session record or routes a fact. A folder name is never a project:
// the project comes from the session store's decision (T-332). Add a new writer here.
const WRITERS = [
  "packages/brain/src/memory/brain-dump.ts",
  "packages/brain/src/memory/fact-routing.ts",
  "packages/brain/src/memory/session-facts.ts",
  "packages/loop/src/hooks/desktop-facts.ts",
  "packages/loop/src/hooks/session-end-hook.ts",
  "packages/loop/src/hooks/session-facts-hook.ts",
  "packages/loop/src/sessions/session-closeout.ts",
  "packages/loop/src/sessions/session-projects.ts",
];

test("no record writer derives a project from a folder basename", async () => {
  const kernel = path.resolve("../..");
  const folderish =
    /basename\(\s*[^)]*\b(cwd|workingDirectory|working_directory|gitRoot|repo|root|folder|dir|directory)\b/i;
  for (const relative of WRITERS) {
    const source = await readFile(path.join(kernel, relative), "utf8");
    source.split("\n").forEach((line, index) => {
      assert.ok(
        !folderish.test(line),
        `${relative}:${index + 1} takes a name from a folder: ${line.trim()}`,
      );
    });
  }
});
