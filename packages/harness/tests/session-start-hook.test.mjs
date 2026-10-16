import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OCEAN_BOOTSTRAP_MAX_BYTES } from "@ocean/context/context/resource-injection.js";
import { PROJECTS_DIR, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import {
  claudeNativeHookStatus,
  claudeSessionStartHook,
  oceanWorktreeWarning,
  sessionStartHookForClient,
  WORKTREE_WARNING_MAX_BYTES,
} from "../dist/application/hooks/session-start-hook.js";

test("claudeSessionStartHook returns the documented Claude Code hookSpecificOutput shape", async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "ocean-hook-outside-"));
  const result = await claudeSessionStartHook({ cwd: outside });
  assert.equal(result.hookSpecificOutput.hookEventName, "SessionStart");
  assert.ok(
    Buffer.byteLength(result.hookSpecificOutput.additionalContext) <=
      OCEAN_BOOTSTRAP_MAX_BYTES,
  );
  assert.match(
    result.hookSpecificOutput.additionalContext,
    /^ocean=1 project=/,
  );
});

test("claudeSessionStartHook reports unbound for a cwd with no Ocean binding, not a guess", async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "ocean-hook-unbound-"));
  const oceanRoot = await mkdtemp(path.join(os.tmpdir(), "ocean-hook-root-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = oceanRoot;
  try {
    const result = await claudeSessionStartHook({ cwd: outside });
    assert.match(
      result.hookSpecificOutput.additionalContext,
      /project=unbound/,
    );
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});

test("ocean hook session-start CLI: bounded stdout JSON, run from a cwd outside Ocean, no Ocean file content", () => {
  const outside = os.tmpdir();
  const payload = JSON.stringify({
    cwd: outside,
    session_id: "cli-test",
    hook_event_name: "SessionStart",
  });
  const result = spawnSync(
    process.execPath,
    [path.resolve("dist/main.js"), "hook", "session-start"],
    { input: payload, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.ok(
    Buffer.byteLength(parsed.hookSpecificOutput.additionalContext) <= 256,
  );
  assert.doesNotMatch(
    parsed.hookSpecificOutput.additionalContext,
    /MEMORY|KNOWLEDGE|## Ocean resource/,
  );
});

test("ocean hook session-start CLI works with no stdin payload at all (falls back to process cwd)", () => {
  const result = spawnSync(
    process.execPath,
    [path.resolve("dist/main.js"), "hook", "session-start"],
    { input: "", encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
});

test("ocean hook session-start --client codex keeps the hookSpecificOutput shape", () => {
  const result = spawnSync(
    process.execPath,
    [
      path.resolve("dist/main.js"),
      "hook",
      "session-start",
      "--client",
      "codex",
    ],
    { input: JSON.stringify({ cwd: os.tmpdir() }), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(parsed.hookSpecificOutput.additionalContext, /^ocean=1 /);
});

test("ocean hook session-start --client hermes emits Hermes' {context} shape only", () => {
  const result = spawnSync(
    process.execPath,
    [
      path.resolve("dist/main.js"),
      "hook",
      "session-start",
      "--client",
      "hermes",
    ],
    {
      input: JSON.stringify({ cwd: os.tmpdir(), session_id: "sess_1" }),
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout.trim());
  assert.deepEqual(Object.keys(parsed), ["context"]);
  assert.match(parsed.context, /^ocean=1 /);
  assert.ok(
    Buffer.byteLength(parsed.context) <= 256 + WORKTREE_WARNING_MAX_BYTES + 1,
  );
});

function runHook(args, input) {
  return spawnSync(
    process.execPath,
    [path.resolve("dist/main.js"), "hook", "session-start", ...args],
    { input, encoding: "utf8" },
  );
}

test("hermes gets the bootstrap on the first turn only (pre_llm_call fires every turn)", () => {
  const later = runHook(
    ["--client", "hermes"],
    JSON.stringify({ cwd: os.tmpdir(), extra: { is_first_turn: false } }),
  );
  assert.equal(later.status, 0, later.stderr);
  assert.deepEqual(JSON.parse(later.stdout.trim()), {});
  const first = runHook(
    ["--client=hermes"],
    JSON.stringify({ cwd: "", extra: { is_first_turn: true } }),
  );
  assert.equal(first.status, 0, first.stderr);
  assert.match(JSON.parse(first.stdout.trim()).context, /^ocean=1 /);
});

test("ocean hook session-start treats a non-object JSON payload as empty", () => {
  for (const input of ["null", "42", '"x"', "[]"]) {
    const result = runHook([], input);
    assert.equal(result.status, 0, `${input}: ${result.stderr}`);
    assert.match(
      JSON.parse(result.stdout.trim()).hookSpecificOutput.additionalContext,
      /^ocean=1 /,
    );
  }
});

test("ocean hook session-start rejects an unknown or missing --client value", () => {
  for (const args of [["--client", "cursor"], ["--client"]]) {
    const result = spawnSync(
      process.execPath,
      [path.resolve("dist/main.js"), "hook", "session-start", ...args],
      { input: "", encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /--client claude\|codex\|hermes/);
  }
});

test("readBoundedStdin rejects a payload larger than its bound instead of buffering it unbounded", async () => {
  const { readBoundedStdin } = await import(
    "../dist/application/hooks/session-start-hook.js"
  );
  const { Readable } = await import("node:stream");
  const oversized = Readable.from([Buffer.alloc(200, "x")]);
  oversized.isTTY = false;
  await assert.rejects(() => readBoundedStdin(oversized, 100), /exceeds/);
});

test("claudeNativeHookStatus reports not-installed/not-registered honestly when neither exists", async () => {
  const fakeHome = await mkdtemp(path.join(os.tmpdir(), "ocean-fake-home-"));
  const status = await claudeNativeHookStatus(fakeHome);
  assert.equal(status.scriptInstalled, false);
  assert.equal(status.registered, false);
});

test("claudeNativeHookStatus reports installed-but-not-registered when the script exists but settings.json does not reference it", async () => {
  const fakeHome = await mkdtemp(path.join(os.tmpdir(), "ocean-fake-home-"));
  await mkdir(
    path.join(
      fakeHome,
      "ocean",
      SYSTEM_DIR,
      "integrations",
      "claude-code",
      "hooks",
    ),
    {
      recursive: true,
    },
  );
  await writeFile(
    path.join(
      fakeHome,
      "ocean",
      SYSTEM_DIR,
      "integrations",
      "claude-code",
      "hooks",
      "ocean-session-bootstrap",
    ),
    "#!/bin/sh\n",
  );
  await mkdir(path.join(fakeHome, ".claude"), { recursive: true });
  await writeFile(
    path.join(fakeHome, ".claude", "settings.json"),
    JSON.stringify({ hooks: { SessionStart: [] } }),
  );
  const status = await claudeNativeHookStatus(fakeHome);
  assert.equal(status.scriptInstalled, true);
  assert.equal(status.registered, false);
});

test("claudeNativeHookStatus reports registered only when settings.json actually references the script", async () => {
  const fakeHome = await mkdtemp(path.join(os.tmpdir(), "ocean-fake-home-"));
  await mkdir(
    path.join(
      fakeHome,
      "ocean",
      SYSTEM_DIR,
      "integrations",
      "claude-code",
      "hooks",
    ),
    {
      recursive: true,
    },
  );
  const scriptPath = path.join(
    fakeHome,
    "ocean",
    SYSTEM_DIR,
    "integrations",
    "claude-code",
    "hooks",
    "ocean-session-bootstrap",
  );
  await writeFile(scriptPath, "#!/bin/sh\n");
  await mkdir(path.join(fakeHome, ".claude"), { recursive: true });
  await writeFile(
    path.join(fakeHome, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: scriptPath }] }],
      },
    }),
  );
  const status = await claudeNativeHookStatus(fakeHome);
  assert.equal(status.registered, true);
});

for (const [folder, hook] of [["ocean", "ocean-session-bootstrap"]]) {
  test(`claudeNativeHookStatus finds ${hook} under ~/${folder} and its registration`, async () => {
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), "ocean-fake-home-"));
    const hooks = path.join(
      fakeHome,
      folder,
      SYSTEM_DIR,
      "integrations",
      "claude-code",
      "hooks",
    );
    await mkdir(hooks, { recursive: true });
    const scriptPath = path.join(hooks, hook);
    await writeFile(scriptPath, "#!/bin/sh\n");
    await mkdir(path.join(fakeHome, ".claude"), { recursive: true });
    await writeFile(
      path.join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: scriptPath }] }],
        },
      }),
    );
    const status = await claudeNativeHookStatus(fakeHome);
    assert.equal(status.scriptInstalled, true);
    assert.equal(status.scriptPath, scriptPath);
    assert.equal(status.registered, true);
  });
}

async function hookHome({ script, registered }) {
  const fakeHome = await mkdtemp(path.join(os.tmpdir(), "ocean-fake-home-"));
  const hooks = path.join(
    fakeHome,
    "ocean",
    SYSTEM_DIR,
    "integrations",
    "claude-code",
    "hooks",
  );
  await mkdir(hooks, { recursive: true });
  if (script) await writeFile(path.join(hooks, script), "#!/bin/sh\n");
  await mkdir(path.join(fakeHome, ".claude"), { recursive: true });
  await writeFile(
    path.join(fakeHome, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: `${hooks}/${registered}` }] },
        ],
      },
    }),
  );
  return fakeHome;
}

test("claudeNativeHookStatus does not count a registration of the other hook name when a script is installed (half-migrated machine)", async () => {
  const status = await claudeNativeHookStatus(
    await hookHome({
      script: "ocean-session-bootstrap",
      registered: "other-session-bootstrap",
    }),
  );
  assert.equal(status.scriptInstalled, true);
  assert.equal(status.registered, false);
});

test("claudeNativeHookStatus still reports a registration when no script is installed", async () => {
  for (const registered of ["ocean-session-bootstrap"]) {
    const status = await claudeNativeHookStatus(
      await hookHome({ script: null, registered }),
    );
    assert.equal(status.scriptInstalled, false);
    assert.equal(status.registered, true, registered);
  }
});

// The Docker image ships without git; these tests need it to build their sample repos.
const noGit =
  spawnSync("git", ["--version"]).status !== 0 && "git is not installed";

async function withGitOceanRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-hook-git-root-"));
  const init = spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("oceanWorktreeWarning is silent for a clean Ocean repo", {
  skip: noGit,
}, async () => {
  await withGitOceanRoot(async (root) => {
    assert.equal(await oceanWorktreeWarning(root), null);
  });
});

test("oceanWorktreeWarning names the uncommitted changes and the worktree command, bounded", {
  skip: noGit,
}, async () => {
  await withGitOceanRoot(async (root) => {
    await mkdir(path.join(root, "01-daily"), { recursive: true });
    await writeFile(path.join(root, "01-daily", "a.md"), "a\n");
    await writeFile(path.join(root, "b.md"), "b\n");
    const warning = await oceanWorktreeWarning(path.join(root, "01-daily"));
    assert.match(warning, /^ocean-dirty=2: /);
    // A temp root's worktree path is too long for the bound, so it shows as a placeholder;
    // the command is never cut in half.
    assert.ok(
      /git worktree add \S+-worktrees>?[\\/]<slug> -b <branch>$/.test(warning),
      warning,
    );
    assert.ok(Buffer.byteLength(warning) <= WORKTREE_WARNING_MAX_BYTES);

    const result = await claudeSessionStartHook({ cwd: root });
    const [bootstrap, line] =
      result.hookSpecificOutput.additionalContext.split("\n");
    assert.ok(Buffer.byteLength(bootstrap) <= OCEAN_BOOTSTRAP_MAX_BYTES);
    assert.equal(line, warning);
  });
});

test("oceanWorktreeWarning is silent outside the Ocean root and in a root that is not a git repo", {
  skip: noGit,
}, async () => {
  await withGitOceanRoot(async (root) => {
    await writeFile(path.join(root, "dirty.md"), "x\n");
    const outside = await mkdtemp(path.join(os.tmpdir(), "ocean-hook-else-"));
    assert.equal(await oceanWorktreeWarning(outside), null);
    await rm(outside, { recursive: true, force: true });
  });
  const plain = await mkdtemp(path.join(os.tmpdir(), "ocean-hook-plain-"));
  await writeFile(path.join(plain, "dirty.md"), "x\n");
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = plain;
  try {
    assert.equal(await oceanWorktreeWarning(plain), null);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
    await rm(plain, { recursive: true, force: true });
  }
});

async function boundProjectFixture(manifest) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-hook-rules-"));
  const repo = await mkdtemp(path.join(os.tmpdir(), "ocean-hook-repo-"));
  await mkdir(path.join(root, PROJECTS_DIR, "lab"), { recursive: true });
  await writeFile(
    path.join(root, PROJECTS_DIR, "lab", "project.json"),
    typeof manifest === "string"
      ? manifest
      : JSON.stringify({ name: "lab", paths: [repo], ...manifest }),
  );
  return { root, repo };
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

test("a bound project with rules gets rules=N and the bounded rules block", async () => {
  const { root, repo } = await boundProjectFixture({
    rules: [".env points at production", "never run migrations"],
  });
  await withRoot(root, async () => {
    for (const client of ["claude", "codex", "hermes"]) {
      const result = await sessionStartHookForClient(client, { cwd: repo });
      const text =
        client === "hermes"
          ? result.context
          : result.hookSpecificOutput.additionalContext;
      const [bootstrap, ...rest] = text.split("\n");
      assert.match(bootstrap, /project=lab .* rules=2 ops=/, client);
      assert.ok(Buffer.byteLength(bootstrap) <= OCEAN_BOOTSTRAP_MAX_BYTES);
      assert.equal(
        rest.join("\n"),
        "Project rules (lab):\n- .env points at production\n- never run migrations",
        client,
      );
    }
  });
});

test("the rules block stays bounded at the manifest limits", async () => {
  const rule = "x".repeat(200);
  const { root, repo } = await boundProjectFixture({
    rules: Array.from({ length: 10 }, () => rule),
  });
  await withRoot(root, async () => {
    const result = await claudeSessionStartHook({ cwd: repo });
    const text = result.hookSpecificOutput.additionalContext;
    assert.ok(Buffer.byteLength(text) <= OCEAN_BOOTSTRAP_MAX_BYTES + 2_400);
  });
});

test("no rules means no token and no block", async () => {
  const { root, repo } = await boundProjectFixture({});
  await withRoot(root, async () => {
    const text = (await claudeSessionStartHook({ cwd: repo }))
      .hookSpecificOutput.additionalContext;
    assert.match(text, /project=lab/);
    assert.doesNotMatch(text, /rules=|Project rules/);
    assert.ok(Buffer.byteLength(text) <= OCEAN_BOOTSTRAP_MAX_BYTES);
  });
});

test("a corrupt manifest still yields a bootstrap, and says its project is unbound", async () => {
  const { root, repo } = await boundProjectFixture("{bad");
  await withRoot(root, async () => {
    const text = (await claudeSessionStartHook({ cwd: repo }))
      .hookSpecificOutput.additionalContext;
    assert.match(text, /^ocean=1 project=/);
    assert.doesNotMatch(text, /Project rules \(/);
    // Fail visible: the session is unbound because the manifest does not parse.
    assert.match(
      text,
      /Ocean: 1 project manifest\(s\) unreadable, those projects are unbound and their rules not loaded: 04-projects[\\/]lab[\\/]project\.json/,
    );
  });
  const invalid = await boundProjectFixture({ rules: "not a list" });
  await withRoot(invalid.root, async () => {
    const text = (await claudeSessionStartHook({ cwd: invalid.repo }))
      .hookSpecificOutput.additionalContext;
    assert.match(text, /^ocean=1 project=lab /);
    assert.doesNotMatch(text, /rules=\d/);
    assert.match(
      text,
      /Project rules \(lab\) unreadable: rules must be a list of strings — fix 04-projects\/lab\/project\.json/,
    );
  });
});
