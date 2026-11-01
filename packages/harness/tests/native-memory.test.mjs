import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  harvestMemory,
  importClaudeExport,
} from "@ocean/brain/memory/memory-harvest.js";
import {
  applyNative,
  nativeFindings,
  planNative,
  restoreNative,
} from "../dist/application/clients/native.js";

// T-296 P4: native-memory policies on a synthetic home, and harvest into candidates.
const ENTRY = {
  command: "/opt/test/node",
  args: ["/release/current/main.js", "mcp", "serve"],
};
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const CODEX = 'model = "gpt-test"\n\n[mcp_servers.ocean]\ncommand = "node"\n';
const GEMINI = json({ security: { auth: { selectedType: "oauth-personal" } } });
const QWEN = json({ tools: { exclude: ["shell"] } });
const CLAUDE = '{"permissions": {"allow": []}}\n';

async function fixture(files = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "ocean-native-"));
  const home = path.join(base, "home");
  const root = path.join(base, "ocean");
  const bin = path.join(base, "bin");
  await mkdir(bin, { recursive: true });
  for (const name of [
    "claude",
    "codex",
    "gemini",
    "qwen",
    "hermes",
    "agy",
    "cursor-agent",
  ]) {
    await writeFile(path.join(bin, name), "#!/bin/sh\n");
    await chmod(path.join(bin, name), 0o755);
  }
  const all = {
    ".claude/settings.json": CLAUDE,
    ".codex/config.toml": CODEX,
    ".gemini/settings.json": GEMINI,
    ".qwen/settings.json": QWEN,
    ".hermes/config.yaml": "memory:\n  memory_enabled: true\n",
    ...files,
  };
  for (const [relative, text] of Object.entries(all)) {
    await mkdir(path.dirname(path.join(home, relative)), { recursive: true });
    await writeFile(path.join(home, relative), text);
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

const read = (home, file) => readFile(path.join(home, file), "utf8");
const statuses = (plans) =>
  Object.fromEntries(plans.map((plan) => [plan.client, plan.status]));

test("plan names each client's native-memory policy", async () => {
  const { root, env } = await fixture();
  await withRoot(root, async () => {
    const plans = await planNative(env);
    assert.deepEqual(statuses(plans), {
      "claude-code": "manual",
      codex: "change",
      gemini: "change",
      qwen: "change",
      hermes: "manual",
      cursor: "toggle",
      antigravity: "harvest",
    });
    const claude = plans.find((plan) => plan.client === "claude-code");
    const [key, value] = claude.setting.split(" = ");
    assert.equal(key, "autoMemoryDirectory");
    assert.ok(
      JSON.parse(value).endsWith(
        path.join("00-inbox", "native", "claude-code"),
      ),
      claude.setting,
    );
    assert.match(claude.reason, /canonical/);
  });
});

test("apply sets only the managed switches, is idempotent, and restore is byte-identical", async () => {
  const { home, root, env } = await fixture();
  await withRoot(root, async () => {
    const { batch, results } = await applyNative({ env });
    assert.deepEqual(results.map((item) => item.client).sort(), [
      "codex",
      "gemini",
      "qwen",
    ]);
    assert.equal(
      await read(home, ".codex/config.toml"),
      `${CODEX}\n[memories]\ngenerate_memories = false\nuse_memories = false\n`,
    );
    const gemini = JSON.parse(await read(home, ".gemini/settings.json"));
    assert.deepEqual(gemini.tools, { exclude: ["save_memory"] });
    assert.deepEqual(gemini.security, {
      auth: { selectedType: "oauth-personal" },
    });
    assert.deepEqual(
      JSON.parse(await read(home, ".qwen/settings.json")).tools.exclude,
      ["shell", "save_memory"],
    );
    assert.equal(await read(home, ".claude/settings.json"), CLAUDE);
    assert.deepEqual((await applyNative({ env })).results, []);
    assert.equal(statuses(await planNative(env)).codex, "current");
    const restored = await restoreNative({ batch, env });
    assert.equal(restored.conflicts.length, 0);
    assert.equal(await read(home, ".codex/config.toml"), CODEX);
    assert.equal(await read(home, ".gemini/settings.json"), GEMINI);
    assert.equal(await read(home, ".qwen/settings.json"), QWEN);
  });
});

test("an existing [memories] value is replaced and put back; a user change is a conflict", async () => {
  const toml = `${CODEX}\n[memories]\ngenerate_memories = true\n\n[other]\nx = 1\n`;
  const { home, root, env } = await fixture({ ".codex/config.toml": toml });
  await withRoot(root, async () => {
    const { batch } = await applyNative({ env, clients: ["codex"] });
    const applied = await read(home, ".codex/config.toml");
    assert.match(
      applied,
      /\[memories\]\ngenerate_memories = false\nuse_memories = false\n\n\[other\]\nx = 1\n$/,
    );
    await restoreNative({ batch, env });
    assert.equal(await read(home, ".codex/config.toml"), toml);
    const second = await applyNative({ env, clients: ["codex"] });
    const flipped = (await read(home, ".codex/config.toml")).replace(
      "use_memories = false",
      "use_memories = true",
    );
    await writeFile(path.join(home, ".codex/config.toml"), flipped);
    const result = await restoreNative({ batch: second.batch, env });
    assert.deepEqual(result, { restored: [], conflicts: ["codex:native"] });
    assert.equal(await read(home, ".codex/config.toml"), flipped);
  });
});

test("a canonical Claude settings file gets the staging directory, and restore removes it", async () => {
  const canonical = json({ permissions: { allow: [] } });
  const { home, root, env } = await fixture({
    ".claude/settings.json": canonical,
  });
  await withRoot(root, async () => {
    const { batch } = await applyNative({ env, clients: ["claude-code"] });
    const settings = JSON.parse(await read(home, ".claude/settings.json"));
    assert.equal(
      settings.autoMemoryDirectory,
      path.join(root, "00-inbox", "native", "claude-code"),
    );
    await restoreNative({ batch, env });
    assert.equal(await read(home, ".claude/settings.json"), canonical);
  });
});

test("doctor: a settable switch left unset fails, toggles and harvest warn, a set switch passes", async () => {
  const { root, env } = await fixture();
  await withRoot(root, async () => {
    const before = await nativeFindings(env);
    const code = (client) =>
      before.find((item) => item.message.startsWith(`${client} `)).code;
    assert.equal(code("codex"), "NATIVE_COMPETING");
    assert.equal(
      before.find((item) => item.message.startsWith("codex ")).severity,
      "FAIL",
    );
    assert.equal(code("cursor"), "NATIVE_TOGGLE_PENDING");
    assert.equal(code("antigravity"), "NATIVE_HARVEST");
    await applyNative({ env, clients: ["codex"] });
    const after = await nativeFindings(env);
    assert.equal(
      after.find((item) => item.message.startsWith("codex ")).code,
      "NATIVE_POLICY_SET",
    );
  });
});

test("Hermes: its YAML switches are read, never written; both off is current (T-300)", async () => {
  const yaml = (enabled, profile) =>
    `model: x\nmemory:\n  # Ocean is the memory home\n  memory_enabled: ${enabled}\n  user_profile_enabled: ${profile}  # owner\nother:\n  memory_enabled: true\n`;
  const hermes = async (text) => {
    const { root, env, home } = await fixture({ ".hermes/config.yaml": text });
    return withRoot(root, async () => {
      const plan = (await planNative(env)).find(
        (item) => item.client === "hermes",
      );
      const finding = (await nativeFindings(env)).find((item) =>
        item.message.startsWith("hermes "),
      );
      await applyNative({ env });
      return { plan, finding, after: await read(home, ".hermes/config.yaml") };
    });
  };

  const half = await hermes(yaml("false", "true"));
  assert.equal(half.plan.status, "manual");
  assert.equal(half.finding.code, "NATIVE_COMPETING");
  assert.equal(half.finding.severity, "FAIL");
  assert.doesNotMatch(half.finding.message, /undefined/);
  assert.match(
    half.finding.message,
    /memory\.memory_enabled: false, memory\.user_profile_enabled: false in ~\/\.hermes\/config\.yaml/,
  );
  assert.equal(
    half.after,
    yaml("false", "true"),
    "apply never writes the YAML",
  );

  const off = await hermes(yaml("false", "false"));
  assert.equal(off.plan.status, "current");
  assert.equal(off.finding.code, "NATIVE_POLICY_SET");

  // A key of the same name in another section does not count.
  const elsewhere = await hermes(
    "memory:\n  user_profile_enabled: false\nother:\n  memory_enabled: false\n",
  );
  assert.equal(elsewhere.plan.status, "manual");
});

test("harvest proposes each native memory once, skips oversized and secret texts, never in a dry run", async () => {
  const { home, root } = await fixture();
  const put = async (file, text) => {
    await mkdir(path.dirname(path.join(home, file)), { recursive: true });
    await writeFile(path.join(home, file), text);
  };
  await put(".codex/memories/a.md", "# Codex note\n\nPrefers pnpm.\n");
  await put(".gemini/memory/feedback-1.md", "Keep answers short.\n");
  await put(
    ".gemini/GEMINI.md",
    "# Context\n\n## Gemini Added Memories\n- likes green tea\n",
  );
  await put(".claude/projects/p1/memory/note.md", "Works in Baghdad time.\n");
  await put(".claude/projects/p1/memory/MEMORY.md", "- [note](note.md)\n");
  await put(".hermes/memories/h.txt", "Hermes remembers the build flag.\n");
  await put(
    ".gemini/antigravity/brain/abc/task.md",
    "# Task\n\nRefactor the parser.\n",
  );
  await put(".codex/memories/big.md", `${"x".repeat(33_000)}\n`);
  await put(".codex/memories/leak.md", `token ${"ghp_"}${"k".repeat(36)}\n`);
  await withRoot(root, async () => {
    const dry = await harvestMemory({ home });
    assert.equal(dry.filter((item) => item.status === "new").length, 7);
    assert.equal(
      dry.find((item) => item.file.endsWith("big.md")).status,
      "too-large",
    );
    assert.ok(!dry.some((item) => item.file.endsWith("MEMORY.md")));
    await assert.rejects(readdir(path.join(root, "00-inbox", "candidates")));
    const applied = await harvestMemory({ home, apply: true });
    assert.equal(
      applied.filter((item) => item.status === "proposed").length,
      6,
    );
    assert.equal(
      applied.find((item) => item.file.endsWith("leak.md")).status,
      "secret",
    );
    const again = await harvestMemory({ home, apply: true });
    assert.equal(again.filter((item) => item.status === "proposed").length, 0);
    assert.equal(again.filter((item) => item.status === "seen").length, 6);
  });
});

test("a claude.ai export becomes candidates per project and doc; a missing file is reported", async () => {
  const { root } = await fixture();
  const exportDir = await mkdtemp(
    path.join(os.tmpdir(), "ocean-claude-export-"),
  );
  await writeFile(
    path.join(exportDir, "projects.json"),
    JSON.stringify([
      {
        name: "letspeak",
        description: "Speaking practice app",
        prompt_template: "Reply in English.",
        docs: [{ filename: "notes.md", content: "Level B2 target." }],
      },
    ]),
  );
  await withRoot(root, async () => {
    const dry = await importClaudeExport(exportDir);
    assert.deepEqual(
      dry.items.map((item) => item.status),
      ["new", "new"],
    );
    const applied = await importClaudeExport(exportDir, { apply: true });
    assert.deepEqual(
      applied.items.map((item) => item.status),
      ["proposed", "proposed"],
    );
    const empty = await mkdtemp(path.join(os.tmpdir(), "ocean-claude-empty-"));
    assert.deepEqual((await importClaudeExport(empty)).problems, [
      "projects.json not found in the export",
    ]);
  });
});
