import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyClients,
  clientFindings,
  confirmClient,
  edit,
  planClients,
  readClientState,
  recordVerification,
  repairClients,
  restoreClients,
  temporaryEntryProblem,
  verifyClient,
} from "../dist/application/clients/clients.js";

// Synthetic home only: config shapes mirror real clients, every value is fake. The FAKE_*
// strings stand in for credentials that live beside MCP entries in real configs.
const FAKE_TOKEN = `sk-ant-${"f".repeat(24)}`;
const FAKE_KEY = `ghp_${"k".repeat(36)}`;
// Built at runtime so the source holds no literal address for the privacy scan.
const FAKE_EMAIL = ["someone", "example.test"].join("@");
const ENTRY = {
  command: "/opt/test/node",
  args: ["/release/current/packages/harness/dist/main.js", "mcp", "serve"],
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

const FIXTURES = {
  ".claude.json": JSON.stringify(
    {
      oauthAccount: { emailAddress: FAKE_EMAIL, token: FAKE_TOKEN },
      projects: { "/tmp/x": { allowedTools: [] } },
      mcpServers: {
        other: { command: "x", env: { API_KEY: FAKE_KEY } },
      },
    },
    null,
    2,
  ),
  "Library/Application Support/Claude/claude_desktop_config.json":
    JSON.stringify(
      {
        mcpServers: { "ocean-uiux": { command: "node", args: ["ui.mjs"] } },
        preferences: { a: 1 },
      },
      null,
      2,
    ),
  ".codex/config.toml": [
    'model = "gpt-test"',
    "",
    "[mcp_servers.ocean]",
    'command = "/opt/homebrew/bin/node"',
    'args = ["/old/kernel/packages/harness/dist/main.js", "mcp", "serve"]',
    'cwd = "/old/kernel/packages/harness"',
    "",
    "[mcp_servers.render]",
    'url = "https://render.example.test/mcp"',
    "",
    "[mcp_servers.render.oauth]",
    `access_token = "${FAKE_TOKEN}"`,
    "",
  ].join("\n"),
  ".gemini/settings.json": json({
    security: { auth: { selectedType: "oauth-personal" } },
    mcpServers: {
      ocean: { command: "node", args: ["/old/main.js", "obsidian", "mcp"] },
    },
  }),
  ".gemini/antigravity/mcp_config.json": json({
    mcpServers: {
      ocean: { command: "node", args: ["/old/main.js", "obsidian", "mcp"] },
      "ocean-obsidian": {
        command: "node",
        args: ["/new/main.js", "obsidian", "mcp"],
      },
    },
  }),
  ".hermes/config.yaml": [
    "model:",
    `  api_key: ${FAKE_KEY}`,
    "mcp_servers:",
    "  ocean:",
    "    command: /opt/homebrew/bin/node",
    "    args:",
    "      - /old/main.js",
    "      - obsidian",
    "      - mcp",
    "onboarding:",
    "  seen: true",
    "",
    "# >>> managed block of another tool",
    "",
  ].join("\n"),
  ".config/opencode/opencode.json":
    '{\n  "mcp": {\n    "atlas": {\n      "type": "local",\n      "command": ["/gone/atlas/engine/cli/atlas-mcp-gateway"],\n      "enabled": true\n    }\n  }\n}\n',
  ".qwen/settings.json": JSON.stringify(
    {
      mcpServers: {
        atlas: {
          command: "/gone/atlas/engine/cli/atlas-mcp-gateway",
          args: [],
        },
      },
      $version: 2,
    },
    null,
    2,
  ),
  ".continue/config.yaml":
    "name: test\nmcpServers:\n  - name: Atlas\n    command: /gone/atlas\n",
};

async function fixtureHome() {
  const base = await mkdtemp(path.join(os.tmpdir(), "ocean-clients-"));
  const home = path.join(base, "home");
  const bin = path.join(base, "bin");
  const apps = path.join(base, "Applications");
  const root = path.join(base, "ocean");
  await mkdir(bin, { recursive: true });
  await mkdir(root, { recursive: true });
  for (const name of [
    "claude",
    "codex",
    "gemini",
    "agy",
    "cursor-agent",
    "hermes",
    "opencode",
    "qwen",
    "aider",
  ]) {
    await writeFile(path.join(bin, name), "#!/bin/sh\n");
    await chmod(path.join(bin, name), 0o755);
  }
  for (const app of ["Claude.app", "ChatGPT.app", "Xcode.app"])
    await mkdir(path.join(apps, app), { recursive: true });
  for (const [relative, content] of Object.entries(FIXTURES)) {
    await mkdir(path.dirname(path.join(home, relative)), { recursive: true });
    await writeFile(path.join(home, relative), content);
  }
  await chmod(path.join(home, ".codex/config.toml"), 0o600);
  await chmod(
    path.join(
      home,
      "Library/Application Support/Claude/claude_desktop_config.json",
    ),
    0o600,
  );
  // Cursor's config is a symlink to a file kept elsewhere: the link must survive.
  const real = path.join(base, "dotfiles", "cursor-mcp.json");
  await mkdir(path.dirname(real), { recursive: true });
  await writeFile(
    real,
    json({
      mcpServers: {
        ocean: { command: "node", args: ["/old", "mcp", "serve"] },
      },
    }),
  );
  await mkdir(path.join(home, ".cursor"), { recursive: true });
  await symlink(real, path.join(home, ".cursor/mcp.json"));
  return {
    home,
    root,
    real,
    env: { home, pathDirs: [bin], appDirs: [apps], entry: ENTRY },
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

const statuses = (plans) =>
  Object.fromEntries(
    plans
      .filter((plan) => plan.installed)
      .map((plan) => [plan.client, plan.status]),
  );

test("plan classifies every installed client and names each change", async () => {
  const { root, env } = await fixtureHome();
  await withRoot(root, async () => {
    const plans = await planClients(env);
    assert.deepEqual(statuses(plans), {
      "claude-code": "change",
      "claude-desktop": "change",
      codex: "change",
      gemini: "change",
      antigravity: "change",
      cursor: "change",
      hermes: "change",
      opencode: "manual",
      qwen: "change",
      continue: "manual",
      aider: "context-file",
      chatgpt: "unsupported",
      xcode: "unknown",
    });
    const ops = (id) =>
      plans
        .find((plan) => plan.client === id)
        .ops.map((op) => `${op.kind}:${op.key}`);
    assert.deepEqual(ops("gemini"), ["rename:ocean", "set:ocean"]);
    assert.deepEqual(ops("antigravity"), ["set:ocean"]);
    assert.deepEqual(ops("qwen"), ["remove:atlas", "set:ocean"]);
    assert.deepEqual(ops("claude-code"), ["set:ocean"]);
    assert.equal(plans.find((plan) => plan.client === "warp").installed, false);
  });
});

test("apply writes only Ocean's entries, keeps modes and links, and is idempotent", async () => {
  const { home, root, real, env } = await fixtureHome();
  await withRoot(root, async () => {
    const { results } = await applyClients({ env });
    assert.deepEqual(results.map((item) => item.client).sort(), [
      "antigravity",
      "claude-code",
      "claude-desktop",
      "codex",
      "cursor",
      "gemini",
      "hermes",
      "qwen",
    ]);
    const read = async (relative) =>
      readFile(path.join(home, relative), "utf8");

    const claude = JSON.parse(await read(".claude.json"));
    assert.deepEqual(claude.mcpServers.ocean, ENTRY);
    assert.deepEqual(
      claude.oauthAccount,
      JSON.parse(FIXTURES[".claude.json"]).oauthAccount,
    );
    assert.deepEqual(claude.mcpServers.other.env, { API_KEY: FAKE_KEY });

    const gemini = JSON.parse(await read(".gemini/settings.json"));
    assert.deepEqual(gemini.mcpServers.ocean, ENTRY);
    assert.deepEqual(gemini.mcpServers["ocean-obsidian"].args, [
      "/old/main.js",
      "obsidian",
      "mcp",
    ]);
    assert.deepEqual(gemini.security, {
      auth: { selectedType: "oauth-personal" },
    });

    const antigravity = JSON.parse(
      await read(".gemini/antigravity/mcp_config.json"),
    );
    assert.deepEqual(Object.keys(antigravity.mcpServers).sort(), [
      "ocean",
      "ocean-obsidian",
    ]);
    assert.deepEqual(
      antigravity.mcpServers["ocean-obsidian"].args[0],
      "/new/main.js",
    );

    assert.deepEqual(
      Object.keys(JSON.parse(await read(".qwen/settings.json")).mcpServers),
      ["ocean"],
    );

    const codex = await read(".codex/config.toml");
    assert.match(
      codex,
      /\[mcp_servers\.ocean\]\ncommand = "\/opt\/test\/node"\nargs = \["\/release\/current\/packages\/harness\/dist\/main\.js", "mcp", "serve"\]\n/,
    );
    assert.ok(codex.startsWith('model = "gpt-test"\n\n'));
    assert.ok(
      codex.includes(
        `[mcp_servers.render.oauth]\naccess_token = "${FAKE_TOKEN}"\n`,
      ),
    );

    const hermes = await read(".hermes/config.yaml");
    assert.ok(
      hermes.startsWith(
        `model:\n  api_key: ${FAKE_KEY}\nmcp_servers:\n  ocean-obsidian:\n`,
      ),
    );
    assert.match(
      hermes,
      / {2}ocean:\n {4}command: "\/opt\/test\/node"\n {4}args:\n {6}- "\/release/,
    );
    assert.ok(
      hermes.endsWith(
        "onboarding:\n  seen: true\n\n# >>> managed block of another tool\n",
      ),
    );

    for (const relative of [
      ".codex/config.toml",
      "Library/Application Support/Claude/claude_desktop_config.json",
    ])
      assert.equal(
        (await stat(path.join(home, relative))).mode & 0o777,
        0o600,
        relative,
      );
    assert.equal(
      (await lstat(path.join(home, ".cursor/mcp.json"))).isSymbolicLink(),
      true,
    );
    assert.deepEqual(
      JSON.parse(await readFile(real, "utf8")).mcpServers.ocean,
      ENTRY,
    );

    assert.equal(
      await read(".config/opencode/opencode.json"),
      FIXTURES[".config/opencode/opencode.json"],
    );
    assert.equal(
      await read(".continue/config.yaml"),
      FIXTURES[".continue/config.yaml"],
    );

    const again = await applyClients({ env });
    assert.deepEqual(again.results, []);
    assert.ok(
      (await planClients(env))
        .filter((plan) => plan.tier === "supported" && plan.installed)
        .every((plan) => plan.status === "current" || plan.status === "manual"),
    );
  });
});

test("the journal and state hold no client secrets and are owner-only", async () => {
  const { root, env } = await fixtureHome();
  await withRoot(root, async () => {
    await applyClients({ env });
    for (const file of [
      path.join(root, "bridge/state/clients/journal.jsonl"),
      path.join(root, "bridge/state/clients/clients.json"),
    ]) {
      const text = await readFile(file, "utf8");
      for (const secret of [
        FAKE_TOKEN,
        FAKE_KEY,
        FAKE_EMAIL,
        "oauth-personal",
        "gpt-test",
      ])
        assert.doesNotMatch(
          text,
          new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          `${file} holds ${secret}`,
        );
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
  });
});

test("an entry with keys Ocean does not manage is a manual step, never rewritten", async () => {
  const { home, root, env } = await fixtureHome();
  const file = path.join(home, ".codex/config.toml");
  const text = `${FIXTURES[".codex/config.toml"]}\n[mcp_servers.ocean.env]\nOCEAN_ROOT = "/somewhere"\n`;
  await writeFile(file, text);
  await withRoot(root, async () => {
    const codex = (await planClients(env)).find(
      (plan) => plan.client === "codex",
    );
    assert.equal(codex.status, "manual");
    await applyClients({ env });
    assert.equal(await readFile(file, "utf8"), text);
  });
});

test("a file changed between read and write is re-read, never overwritten", async () => {
  const { root } = await fixtureHome();
  const file = path.join(root, "client.json");
  await writeFile(file, "first\n");
  await withRoot(root, async () => {
    const seen = [];
    await edit(
      file,
      (text) => {
        seen.push(text);
        // The first time, another writer changes the file after Ocean read it.
        if (seen.length === 1) writeFileSync(file, "theirs\n");
        return { next: `${text.trim()}+ocean\n`, entries: [] };
      },
      "20261030000000-00000000",
    );
    assert.deepEqual(seen, ["first\n", "theirs\n"]);
    assert.equal(await readFile(file, "utf8"), "theirs+ocean\n");
  });
});

test("a replaced entry that carries a secret is journaled by hash only", async () => {
  const { home, root, env } = await fixtureHome();
  const file = path.join(home, ".cursor/mcp.json");
  await writeFile(
    file,
    json({
      mcpServers: {
        ocean: {
          command: "node",
          args: ["/old", "mcp", "serve", "--token", FAKE_TOKEN],
        },
      },
    }),
  );
  await withRoot(root, async () => {
    await applyClients({ clients: ["cursor"], env });
    const journal = await readFile(
      path.join(root, "bridge/state/clients/journal.jsonl"),
      "utf8",
    );
    assert.doesNotMatch(journal, /sk-ant-/);
    assert.match(journal, /"beforeSha":"[0-9a-f]{64}"/);
    const undone = await restoreClients({ env });
    assert.deepEqual(undone.restored, [
      "cursor:ocean (removed; original not stored)",
    ]);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).mcpServers, {});
  });
});

test("restore returns every file byte-identical, and refuses a node the user changed", async () => {
  const { home, root, real, env } = await fixtureHome();
  await withRoot(root, async () => {
    await applyClients({ env });
    const restored = await restoreClients({ env });
    assert.deepEqual(restored.conflicts, []);
    for (const [relative, content] of Object.entries(FIXTURES))
      assert.equal(
        await readFile(path.join(home, relative), "utf8"),
        content,
        relative,
      );
    assert.match(await readFile(real, "utf8"), /"\/old"/);

    // The user edits Ocean's entry after an apply: restore leaves that file alone.
    const second = await applyClients({ env });
    const file = path.join(home, ".gemini/settings.json");
    const edited = JSON.parse(await readFile(file, "utf8"));
    edited.mcpServers.ocean.args = ["my", "own"];
    await writeFile(file, json(edited));
    const result = await restoreClients({ batch: second.batch, env });
    assert.ok(result.conflicts.includes("gemini:ocean"));
    assert.deepEqual(
      JSON.parse(await readFile(file, "utf8")).mcpServers.ocean.args,
      ["my", "own"],
    );
  });
});

test("repair touches only clients the owner approved", async () => {
  const { home, root, env } = await fixtureHome();
  await withRoot(root, async () => {
    assert.deepEqual((await repairClients(env)).results, []);
    await applyClients({ clients: ["cursor"], env });
    const drifted = {
      ...env,
      entry: {
        command: "/opt/test/node",
        args: ["/release/next/main.js", "mcp", "serve"],
      },
    };
    const { results } = await repairClients(drifted);
    assert.deepEqual(results, [{ client: "cursor", result: "written" }]);
    assert.equal(
      await readFile(path.join(home, ".gemini/settings.json"), "utf8"),
      FIXTURES[".gemini/settings.json"],
    );
  });
});

test("doctor findings fail unwired supported clients, warn unknown, report unsupported", async () => {
  const { root, env } = await fixtureHome();
  await withRoot(root, async () => {
    const before = await clientFindings(env);
    const by = (code) =>
      before.filter((finding) => finding.code === code).length;
    assert.equal(by("CLIENT_NOT_WIRED"), 8);
    assert.equal(by("CLIENT_MANUAL"), 2);
    assert.equal(by("CLIENT_UNKNOWN"), 1);
    assert.equal(by("CLIENT_UNSUPPORTED"), 2);
    assert.ok(
      before
        .filter((finding) => finding.code === "CLIENT_NOT_WIRED")
        .every((finding) => finding.severity === "FAIL"),
    );
    assert.equal(
      before.find((finding) => finding.code === "CLIENT_UNKNOWN").severity,
      "WARN",
    );
    assert.ok(
      before
        .find((finding) => finding.message.includes("aider"))
        .message.includes("fallback"),
    );
    await applyClients({ env });
    const after = await clientFindings(env);
    assert.equal(
      after.filter((finding) => finding.severity === "FAIL").length,
      2,
    );
    // Wired but not yet checked in the app: a warning until the owner confirms it.
    assert.equal(
      after.filter((finding) => finding.code === "CLIENT_CHECK_PENDING").length,
      8,
    );
    await confirmClient("cursor");
    const confirmed = await clientFindings(env);
    assert.equal(
      confirmed.filter((finding) => finding.code === "CLIENT_WIRED").length,
      1,
    );
    await recordVerification("cursor", true);
    const state = await readClientState();
    assert.deepEqual(Object.keys(state.confirmed), ["cursor"]);
    assert.equal(state.verified.cursor.ok, true);
    assert.ok(state.approved.cursor, "confirm and verify keep the approvals");
    await assert.rejects(confirmClient("nope"), /unknown client/);
  });
});

test("verify proves the configured command answers as the brain server", async () => {
  const { home, root, env } = await fixtureHome();
  await withRoot(root, async () => {
    const live = {
      ...env,
      entry: {
        command: process.execPath,
        args: [path.resolve("dist/main.js"), "mcp", "serve"],
      },
    };
    await applyClients({ clients: ["cursor", "gemini"], env: live });
    const ok = await verifyClient("cursor", live);
    assert.equal(ok.ok, true, ok.detail);
    await writeFile(
      path.join(home, ".gemini/settings.json"),
      json({
        mcpServers: {
          ocean: {
            command: process.execPath,
            args: [path.resolve("dist/main.js"), "obsidian", "mcp"],
          },
        },
      }),
    );
    const wrong = await verifyClient("gemini", live);
    assert.equal(wrong.ok, false, wrong.detail);
    assert.equal((await verifyClient("aider", live)).ok, false);
  });
});

test("an engine in a temporary directory is refused before any client file is touched", async () => {
  const { home, root, env } = await fixtureHome();
  await withRoot(root, async () => {
    const scratch = {
      ...env,
      entry: {
        command: "/opt/test/node",
        args: [
          path.join(os.tmpdir(), "wt/packages/harness/dist/main.js"),
          "mcp",
          "serve",
        ],
      },
    };
    await assert.rejects(
      applyClients({ env: scratch, durable: true }),
      /Refusing to wire clients: .*temporary directory/,
    );
    assert.equal(
      await readFile(path.join(home, ".gemini/settings.json"), "utf8"),
      FIXTURES[".gemini/settings.json"],
    );
    assert.equal(temporaryEntryProblem(ENTRY), null);
    assert.match(
      temporaryEntryProblem({ args: ["/private/tmp/x/main.js"] }),
      /temporary directory/,
    );
    assert.equal(temporaryEntryProblem({ args: ["/tmpfoo/main.js"] }), null);
  });
});
