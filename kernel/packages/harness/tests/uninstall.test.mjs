import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyClients,
  readJournal,
} from "../dist/application/clients/clients.js";
import { applyHooks } from "../dist/application/clients/hooks.js";
import { removeClaudeCodeWrapper } from "../dist/application/integrations/claude-vscode.js";
import {
  pendingBatches,
  planUninstall,
  purgeRefusal,
  runUninstall,
} from "../dist/application/uninstall/uninstall.js";
import { stripInterceptionBlocks } from "../dist/infrastructure/wrappers/wrapper-manager.js";

// Synthetic home and workspace only; every path and value is fake.
const ENTRY = {
  command: "/opt/test/node",
  args: ["/release/current/packages/harness/dist/main.js", "mcp", "serve"],
};
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const OWNER_SERVER = { command: "owner-server", args: ["--port", "1"] };
const OWNER_HOOK = { hooks: [{ type: "command", command: "echo mine" }] };
const PROFILE_BEFORE = "export EDITOR=vim\n";

async function sandbox() {
  const base = await mkdtemp(path.join(os.tmpdir(), "ocean-uninstall-"));
  const home = path.join(base, "home");
  const root = path.join(base, "ocean");
  const bin = path.join(base, "bin");
  await mkdir(bin, { recursive: true });
  await mkdir(root, { recursive: true });
  await writeFile(path.join(bin, "claude"), "#!/bin/sh\n");
  await chmod(path.join(bin, "claude"), 0o755);
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await writeFile(
    path.join(home, ".claude.json"),
    json({ mcpServers: { owner: OWNER_SERVER } }),
  );
  await writeFile(
    path.join(home, ".claude", "settings.json"),
    json({ hooks: { SessionStart: [OWNER_HOOK] } }),
  );
  const shimDir = path.join(root, "bridge", "runtime", "shims");
  await mkdir(shimDir, { recursive: true });
  await writeFile(path.join(shimDir, "ocean"), "#!/bin/sh\n");
  await writeFile(
    path.join(home, ".zshrc"),
    `${PROFILE_BEFORE}\n# >>> ocean interception >>>\nexport PATH="${shimDir}:$PATH"\n# <<< ocean interception <<<\n`,
  );
  const agents = path.join(home, "Library", "LaunchAgents");
  await mkdir(agents, { recursive: true });
  for (const label of ["com.ocean.runtime", "com.ocean.desktop-capture"])
    await writeFile(path.join(agents, `${label}.plist`), "<plist/>\n");
  const vscode = path.join(base, "vscode-settings.json");
  await writeFile(
    vscode,
    json({
      "editor.fontSize": 13,
      "claudeCode.claudeProcessWrapper": path.join(shimDir, "claude-vscode"),
    }),
  );
  const calls = [];
  return {
    base,
    home,
    root,
    shimDir,
    vscode,
    calls,
    env: { home, pathDirs: [bin], appDirs: [], entry: ENTRY },
    run: async (command, args) => {
      calls.push([command, ...args].join(" "));
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

test("pendingBatches: newest first, skipping batches already restored", () => {
  const entry = (batch, key, restoreOf) => ({
    batch,
    ts: "",
    client: "claude-code",
    file: ".claude.json",
    op: "set",
    key,
    before: null,
    after: null,
    ...(restoreOf ? { restoreOf } : {}),
  });
  const journal = [
    entry("a", "ocean"),
    entry("b", "ocean"),
    entry("b", "market"),
    entry("c", "ocean"),
    entry("undo-c", "ocean", "c"),
    entry("undo-b", "ocean", "b"),
  ];
  // b is only half undone, so it is still pending; c is fully undone.
  assert.deepEqual(pendingBatches(journal), ["b", "a"]);
});

test("uninstall puts client configs, hooks, services, profile and shims back", async () => {
  const box = await sandbox();
  await withRoot(box.root, async () => {
    await applyClients({ env: box.env, clients: ["claude-code"] });
    await applyHooks({ env: box.env, clients: ["claude-code"] });
    const wired = JSON.parse(
      await readFile(path.join(box.home, ".claude.json"), "utf8"),
    );
    assert.ok(wired.mcpServers.ocean, "apply wired the ocean entry");

    const plan = await planUninstall({
      env: box.env,
      platform: "darwin",
      shimDir: box.shimDir,
      stripProfile: stripInterceptionBlocks,
      root: box.root,
    });
    assert.ok(plan.items.some((item) => item.area === "shell"));
    assert.equal(plan.purge, null);

    const report = await runUninstall({
      env: box.env,
      platform: "darwin",
      run: box.run,
      root: box.root,
      shimDir: box.shimDir,
      stripProfile: stripInterceptionBlocks,
      vscodeSettings: box.vscode,
    });

    const claude = JSON.parse(
      await readFile(path.join(box.home, ".claude.json"), "utf8"),
    );
    assert.deepEqual(claude.mcpServers, { owner: OWNER_SERVER });
    const settings = JSON.parse(
      await readFile(path.join(box.home, ".claude", "settings.json"), "utf8"),
    );
    assert.deepEqual(settings.hooks, { SessionStart: [OWNER_HOOK] });
    assert.equal(
      await readFile(path.join(box.home, ".zshrc"), "utf8"),
      PROFILE_BEFORE,
    );
    assert.equal(existsSync(box.shimDir), false);
    for (const label of ["com.ocean.runtime", "com.ocean.desktop-capture"])
      assert.equal(
        existsSync(
          path.join(box.home, "Library", "LaunchAgents", `${label}.plist`),
        ),
        false,
      );
    assert.ok(
      box.calls.some(
        (call) =>
          call.includes("bootout") && call.includes("com.ocean.runtime"),
      ),
    );
    assert.deepEqual(JSON.parse(await readFile(box.vscode, "utf8")), {
      "editor.fontSize": 13,
    });
    assert.equal(report.purged, null);
    assert.ok(existsSync(box.root), "the workspace is kept without --purge");
    assert.deepEqual(report.left, []);
    assert.ok(report.next.some((step) => step.includes("npm uninstall")));
    // The apply batch counts as undone afterwards, so a second run has nothing to restore.
    assert.deepEqual(pendingBatches(await readJournal()), []);
  });
});

test("uninstall removes Ocean entries the journal never recorded, and keeps the owner's", async () => {
  const box = await sandbox();
  await writeFile(
    path.join(box.home, ".claude.json"),
    json({
      mcpServers: {
        owner: OWNER_SERVER,
        ocean: ENTRY,
        "ocean-obsidian": { command: "node", args: ["/x", "obsidian"] },
        github: {
          command: "/opt/test/node",
          args: ["/e/main.js", "market", "exec", "dev.ocean/github"],
        },
      },
    }),
  );
  await writeFile(
    path.join(box.home, ".claude", "settings.json"),
    json({
      hooks: {
        SessionStart: [
          OWNER_HOOK,
          {
            hooks: [
              {
                type: "command",
                command: "ocean hook session-start --client claude --repair",
              },
            ],
          },
        ],
        SessionEnd: [
          {
            hooks: [
              {
                type: "command",
                command: "ocean hook session-end --client claude",
              },
            ],
          },
        ],
      },
    }),
  );
  await withRoot(box.root, async () => {
    await runUninstall({
      env: box.env,
      platform: "darwin",
      run: box.run,
      root: box.root,
      shimDir: box.shimDir,
      stripProfile: stripInterceptionBlocks,
      vscodeSettings: box.vscode,
    });
  });
  const claude = JSON.parse(
    await readFile(path.join(box.home, ".claude.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(claude.mcpServers).sort(), [
    "ocean-obsidian",
    "owner",
  ]);
  const settings = JSON.parse(
    await readFile(path.join(box.home, ".claude", "settings.json"), "utf8"),
  );
  assert.deepEqual(settings.hooks, { SessionStart: [OWNER_HOOK] });
});

test("--purge deletes a plain workspace but refuses a checkout or the home folder", async () => {
  const box = await sandbox();
  assert.match(purgeRefusal(box.home, box.home), /not a workspace folder/);
  await mkdir(path.join(box.base, "checkout", ".git"), { recursive: true });
  assert.match(
    purgeRefusal(path.join(box.base, "checkout"), box.home),
    /git checkout/,
  );
  assert.equal(purgeRefusal(box.root, box.home), null);
  await withRoot(box.root, async () => {
    const report = await runUninstall({
      env: box.env,
      platform: "darwin",
      run: box.run,
      root: box.root,
      shimDir: box.shimDir,
      stripProfile: stripInterceptionBlocks,
      vscodeSettings: box.vscode,
      purge: true,
    });
    assert.equal(report.purged, box.root);
  });
  assert.equal(existsSync(box.root), false);
});

test("removeClaudeCodeWrapper keeps a wrapper that is not Ocean's", async () => {
  const box = await sandbox();
  const own = {
    "claudeCode.claudeProcessWrapper": "/usr/local/bin/my-wrapper",
  };
  await writeFile(box.vscode, json(own));
  assert.equal(await removeClaudeCodeWrapper(box.shimDir, box.vscode), null);
  assert.deepEqual(JSON.parse(await readFile(box.vscode, "utf8")), own);
  // JSONC keeps its comments.
  await writeFile(
    box.vscode,
    `{\n  // mine\n  "a": 1,\n  "claudeCode.claudeProcessWrapper": ${JSON.stringify(path.join(box.shimDir, "claude-vscode"))},\n}\n`,
  );
  assert.equal(
    await removeClaudeCodeWrapper(box.shimDir, box.vscode),
    box.vscode,
  );
  const text = await readFile(box.vscode, "utf8");
  assert.match(text, /\/\/ mine/);
  assert.doesNotMatch(text, /claudeProcessWrapper/);
});
