import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { measureContextCost } from "@ocean/context/context/context-cost.js";

const MARKER = "FIXTURE-BODY-TEXT";

function skillFile(name, body) {
  const frontmatter = `---\nname: ${name}\ndescription: The ${name} skill.\n---\n`;
  return {
    text: `${frontmatter}${body}`,
    frontmatter: Buffer.byteLength(frontmatter),
    body: Buffer.byteLength(body),
  };
}

async function put(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

async function withFakeHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocean-cost-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function writeHomeFixture(home) {
  const claudeRules = [
    "# rules",
    "@~/rules/core.md",
    "@./missing.md",
    "```",
    "@~/ignored.md",
    "```",
    "Inline `@~/ignored.md` is code, not an import.",
    "",
  ].join("\n");
  await put(path.join(home, ".claude", "CLAUDE.md"), claudeRules);
  const core = `core rules ${MARKER}\n`;
  await put(path.join(home, "rules", "core.md"), core);
  await put(path.join(home, "ignored.md"), "ignored");
  const a = skillFile("a", `alpha ${MARKER}\n`);
  const b = skillFile("b", `beta body that is longer ${MARKER}\n`);
  await put(path.join(home, ".claude", "skills", "a", "SKILL.md"), a.text);
  await put(path.join(home, ".claude", "skills", "b", "SKILL.md"), b.text);
  await put(
    path.join(home, ".claude", "skills", "synced", "x", "SKILL.md"),
    skillFile("x", "nested, not loaded by claude\n").text,
  );
  await put(path.join(home, ".gemini", "GEMINI.md"), "gemini rules\n");
  const shared = skillFile("shared", `shared ${MARKER}\n`);
  await put(
    path.join(home, ".agents", "skills", "shared", "SKILL.md"),
    shared.text,
  );
  await mkdir(path.join(home, ".gemini", "skills"), { recursive: true });
  const symlinked = process.platform !== "win32";
  if (symlinked)
    await symlink(
      path.join("..", "..", ".agents", "skills", "shared"),
      path.join(home, ".gemini", "skills", "shared"),
    );
  await put(
    path.join(home, ".hermes", "skills", "cat", "s", "SKILL.md"),
    skillFile("s", "hermes skill\n").text,
  );
  const codexRules = "codex rules\n";
  await put(path.join(home, ".codex", "AGENTS.md"), codexRules);
  const projectDir = path.join(home, "work", "demo");
  const slug = projectDir.replace(/[^a-zA-Z0-9]/g, "-");
  const memory = `- memory index ${MARKER}\n`;
  await put(
    path.join(home, ".claude", "projects", slug, "memory", "MEMORY.md"),
    memory,
  );
  return {
    projectDir,
    symlinked,
    bytes: {
      claudeRules: Buffer.byteLength(claudeRules),
      core: Buffer.byteLength(core),
      memory: Buffer.byteLength(memory),
      codexRules: Buffer.byteLength(codexRules),
      claudeFrontmatter: a.frontmatter + b.frontmatter,
      claudeBody: a.body + b.body,
    },
  };
}

test("context cost measures always-on bytes per client from a fake home", () =>
  withFakeHome(async (home) => {
    const fixture = await writeHomeFixture(home);
    const report = await measureContextCost({
      home,
      projectDir: fixture.projectDir,
      budget: 100,
    });
    const byClient = Object.fromEntries(
      report.clients.map((client) => [client.client, client]),
    );
    assert.deepEqual(Object.keys(byClient), [
      "claude",
      "codex",
      "gemini",
      "hermes",
      "cursor",
      "antigravity",
      "agents",
    ]);

    const claude = byClient.claude;
    assert.deepEqual(claude.rules, [
      { path: "~/.claude/CLAUDE.md", bytes: fixture.bytes.claudeRules },
      {
        path: "~/rules/core.md",
        bytes: fixture.bytes.core,
        via: "~/.claude/CLAUDE.md",
      },
      {
        path: "~/.claude/missing.md",
        bytes: 0,
        via: "~/.claude/CLAUDE.md",
        missing: true,
      },
    ]);
    assert.equal(claude.skills.count, 2);
    assert.equal(
      claude.skills.frontmatterBytes,
      fixture.bytes.claudeFrontmatter,
    );
    assert.equal(claude.skills.bodyBytes, fixture.bytes.claudeBody);
    assert.equal(claude.memory.length, 1);
    assert.match(claude.memory[0].path, /<project-slug>/);
    assert.equal(claude.memory[0].bytes, fixture.bytes.memory);
    assert.equal(
      claude.alwaysOnBytes,
      fixture.bytes.claudeRules +
        fixture.bytes.core +
        fixture.bytes.memory +
        fixture.bytes.claudeFrontmatter,
    );
    assert.equal(claude.overBudget, true);

    assert.deepEqual(byClient.codex.rules, [
      { path: "~/.codex/AGENTS.md", bytes: fixture.bytes.codexRules },
    ]);
    assert.equal(byClient.gemini.skills.count, fixture.symlinked ? 1 : 0);
    assert.equal(byClient.hermes.skills.count, 1);
    for (const client of ["cursor", "antigravity"]) {
      assert.equal(byClient[client].skills.present, false);
      assert.ok(byClient[client].notes.length > 0);
    }
    assert.equal(byClient.agents.shared, true);
    assert.equal(byClient.agents.skills.count, 1);
    assert.equal(byClient.claude.shared, false);

    const paths = report.clients.flatMap((client) => [
      client.skills.root,
      ...client.rules.map((file) => file.path),
      ...client.memory.map((file) => file.path),
      ...client.rules.flatMap((file) => (file.via ? [file.via] : [])),
    ]);
    for (const item of paths)
      assert.ok(
        item.startsWith("~") || item.startsWith("<outside-home>"),
        item,
      );
    assert.equal(report.project, "~/work/demo");
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes(home));
    assert.ok(!serialized.includes(MARKER));
    assert.ok(!serialized.includes("ignored.md"));

    const roomy = await measureContextCost({
      home,
      projectDir: fixture.projectDir,
      budget: 10 ** 9,
    });
    assert.ok(roomy.clients.every((client) => !client.overBudget));

    const noProject = await measureContextCost({ home });
    const claudeNoProject = noProject.clients.find(
      (client) => client.client === "claude",
    );
    assert.deepEqual(claudeNoProject.memory, []);
    assert.ok(claudeNoProject.notes.some((note) => note.includes("--project")));
  }));

test("claude skills hidden from the model cost nothing; commands, agents and plugins count", () =>
  withFakeHome(async (home) => {
    const claude = path.join(home, ".claude");
    const shown = skillFile("shown", `${MARKER}\n`);
    const quiet = skillFile("quiet", `${MARKER}\n`);
    const self = `---\nname: self\ndescription: Hides itself.\ndisable-model-invocation: true\n---\n${MARKER}\n`;
    await put(path.join(claude, "skills", "shown", "SKILL.md"), shown.text);
    await put(path.join(claude, "skills", "quiet", "SKILL.md"), quiet.text);
    await put(path.join(claude, "skills", "self", "SKILL.md"), self);
    const commandFm = "---\ndescription: Runs a thing.\n---\n";
    const command = `${commandFm}Do it.\n`;
    const agentFm = "---\nname: helper\ndescription: Helps.\n---\n";
    const agent = `${agentFm}Prompt.\n`;
    await put(path.join(claude, "commands", "go.md"), command);
    await put(path.join(claude, "commands", "notes.txt"), "not a command");
    await put(path.join(claude, "agents", "helper.md"), agent);
    const plugin = path.join(home, "plugin-root");
    const pluginSkill = skillFile("tool", `${MARKER}\n`);
    await put(
      path.join(plugin, "skills", "tool", "SKILL.md"),
      pluginSkill.text,
    );
    await put(
      path.join(plugin, "skills", "inner", "SKILL.md"),
      skillFile("inner", "").text,
    );
    await put(
      path.join(claude, "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: {
          "kit@market": [{ installPath: plugin }],
          "off@market": [{ installPath: path.join(home, "nope") }],
        },
      }),
    );
    await put(
      path.join(claude, "settings.json"),
      JSON.stringify({
        skillOverrides: {
          quiet: "user-invocable-only",
          "kit:inner": "off",
          shown: "on",
        },
        enabledPlugins: { "kit@market": true, "off@market": false },
      }),
    );
    const report = await measureContextCost({ home, budget: 10 ** 9 });
    const cost = report.clients.find((client) => client.client === "claude");
    assert.equal(cost.skills.count, 1);
    assert.equal(cost.skills.frontmatterBytes, shown.frontmatter);
    assert.equal(cost.skills.hidden, 2);
    assert.deepEqual(cost.extras, [
      { path: "~/.claude/commands", bytes: Buffer.byteLength(commandFm) },
      { path: "~/.claude/agents", bytes: Buffer.byteLength(agentFm) },
      { path: "~/plugin-root", bytes: pluginSkill.frontmatter },
    ]);
    assert.equal(
      cost.alwaysOnBytes,
      shown.frontmatter +
        cost.extras.reduce((total, file) => total + file.bytes, 0),
    );
    assert.ok(!JSON.stringify(report).includes(MARKER));
    // Other clients never read Claude's settings.
    const codex = report.clients.find((client) => client.client === "codex");
    assert.deepEqual(codex.extras, []);
  }));

test("an unreadable Claude settings file is a note, not a failure", () =>
  withFakeHome(async (home) => {
    await put(
      path.join(home, ".claude", "skills", "a", "SKILL.md"),
      skillFile("a", "").text,
    );
    await put(path.join(home, ".claude", "settings.json"), "{ not json");
    const report = await measureContextCost({ home });
    const cost = report.clients.find((client) => client.client === "claude");
    assert.equal(cost.skills.count, 1);
    assert.ok(cost.notes.some((note) => note.includes("settings.json")));
  }));

test("claude memory is keyed by the git root, and a worktree by its main checkout", () =>
  withFakeHome(async (home) => {
    const repo = path.join(home, "work", "repo");
    await mkdir(path.join(repo, ".git", "worktrees", "wt"), {
      recursive: true,
    });
    await mkdir(path.join(repo, "packages", "core"), { recursive: true });
    const slug = repo.replace(/[^a-zA-Z0-9]/g, "-");
    const memory = `- repo memory ${MARKER}\n`;
    await put(
      path.join(home, ".claude", "projects", slug, "memory", "MEMORY.md"),
      memory,
    );
    const claudeMemory = async (projectDir) =>
      (
        await measureContextCost({ home, projectDir, budget: 100 })
      ).clients.find((client) => client.client === "claude").memory;

    // A subdirectory of the checkout resolves to the repository root.
    const fromSubdir = await claudeMemory(path.join(repo, "packages", "core"));
    assert.equal(fromSubdir.length, 1);
    assert.equal(fromSubdir[0].bytes, Buffer.byteLength(memory));
    assert.equal(fromSubdir[0].missing, undefined);

    // A linked worktree (.git file -> gitdir -> commondir) resolves to the main checkout.
    const worktree = path.join(home, "work", "repo-wt");
    const gitDir = path.join(repo, ".git", "worktrees", "wt");
    await put(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    await put(path.join(gitDir, "commondir"), "../..\n");
    const fromWorktree = await claudeMemory(path.join(worktree, "src"));
    assert.equal(fromWorktree[0].bytes, Buffer.byteLength(memory));

    // Outside any repository the directory itself is the key.
    const loose = await claudeMemory(path.join(home, "loose"));
    assert.equal(loose[0].missing, true);
    assert.ok(!JSON.stringify(fromSubdir).includes(home));
  }));

test("ocean context cost prints JSON and a table without contents or home paths", () =>
  withFakeHome(async (home) => {
    const fixture = await writeHomeFixture(home);
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const run = (args) =>
      spawnSync(
        process.execPath,
        [path.resolve("dist/main.js"), "context", "cost", ...args],
        { env, encoding: "utf8" },
      );
    const json = run([
      "--json",
      "--budget",
      "100",
      "--project",
      fixture.projectDir,
    ]);
    assert.equal(json.status, 0, json.stderr);
    const report = JSON.parse(json.stdout);
    assert.equal(report.budget, 100);
    assert.ok(!json.stdout.includes(home));
    assert.ok(!json.stdout.includes(MARKER));

    const table = run(["--budget", "100", "--project", fixture.projectDir]);
    assert.equal(table.status, 0, table.stderr);
    assert.match(
      table.stdout,
      /Always-on context by client \(budget 100 bytes\)/,
    );
    assert.match(table.stdout, /OVER/);
    assert.match(table.stdout, /~\/\.claude\/CLAUDE\.md/);
    assert.ok(!table.stdout.includes(home));
    assert.ok(!table.stdout.includes(MARKER));

    const bad = run(["--budget", "abc"]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Usage: ocean context cost/);
  }));
