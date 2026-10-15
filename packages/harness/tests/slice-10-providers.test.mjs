import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyIntent } from "../dist/application/context/intent-router.js";
import { claudeNativeHookStatus } from "../dist/application/hooks/session-start-hook.js";
import { createGrant } from "../dist/application/operations/write-guard.js";
import {
  invokeProviderHeadless,
  PROVIDER_HEADLESS,
  parseProviderStream,
  providerHeadlessSupport,
} from "../dist/infrastructure/providers/provider-invocation.js";
import { resolveOriginalExecutable } from "../dist/infrastructure/providers/provider-registry.js";
import { SYSTEM_DIR } from "../dist/paths.js";

const BUDGET = {
  maxFiles: 10,
  maxBytes: 50_000,
  maxChars: 5_000,
  maxOperationCost: 5,
};
const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// Live provider tests cost real API quota, so they run only when explicitly requested.
// They are the ONLY evidence that counts for provider compatibility; the fake-executable
// tests below prove the invocation boundary's error handling, never compatibility.
const LIVE = process.env.OCEAN_LIVE_PROVIDER_TESTS === "1";
const live = LIVE ? test : test.skip;
const installedEnvironment = existsSync(
  path.join(os.homedir(), "ocean", SYSTEM_DIR, "runtime", "shims", "ocean"),
);
const installed = installedEnvironment ? test : test.skip;
const unixOnly = process.platform === "win32" ? test.skip : test;

function guardFor(
  provider,
  { approved = true, classification = classifyIntent("run the build") } = {},
) {
  const scope = {
    action: "provider.invoke",
    target: provider,
    identifier: null,
    projectId: "ocean",
  };
  return {
    sessionId: SESSION,
    classification,
    scope,
    budget: BUDGET,
    grant: approved ? createGrant(SESSION, scope) : null,
  };
}

async function fakeProvider(script) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-slice10-fake-"));
  const file = path.join(dir, "fake-provider");
  await writeFile(file, script);
  await chmod(file, 0o755);
  return { dir, file };
}

function resolvesOrNull(provider) {
  try {
    return resolveOriginalExecutable(provider);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- contract surface

test("the same headless contract shape exists for every supported provider", () => {
  for (const provider of ["claude", "codex", "gemini"]) {
    const support = providerHeadlessSupport(provider);
    assert.equal(support.supported, true, provider);
    const args = support.spec.args("PROMPT");
    assert.ok(Array.isArray(args) && args.includes("PROMPT"), provider);
    assert.ok(["json", "text"].includes(support.spec.parse), provider);
  }
});

test("unsupported providers stay explicitly gated, never silently attempted", async () => {
  for (const provider of [
    "hermes",
    "kilo",
    "kimi",
    "copilot",
    "openhands",
    "antigravity",
  ]) {
    const support = providerHeadlessSupport(provider);
    assert.equal(support.supported, false, provider);
    assert.match(support.reason, /unsupported/);
    const result = await invokeProviderHeadless({
      provider,
      prompt: "x",
      oceanSessionId: SESSION,
      cwd: os.tmpdir(),
      guard: guardFor(provider),
    });
    assert.equal(result.status, "unsupported");
    assert.equal(result.exitCode, null);
  }
});

test("no auto-approve or permission-bypass flag is ever passed to a provider", () => {
  const forbidden = [
    "--dangerously-skip-permissions",
    "--full-auto",
    "--dangerously-bypass-approvals-and-sandbox",
    "--yolo",
    "--auto",
  ];
  for (const [provider, spec] of Object.entries(PROVIDER_HEADLESS)) {
    const args = spec.args("prompt");
    for (const flag of forbidden)
      assert.ok(!args.includes(flag), `${provider} must not pass ${flag}`);
  }
});

// ---------------------------------------------------------------- guard before invocation

test("guard rejection happens before any process is spawned", async () => {
  const { file } = await fakeProvider(
    "#!/bin/sh\necho SHOULD-NOT-RUN\nexit 0\n",
  );
  const result = await invokeProviderHeadless({
    provider: "claude",
    prompt: "x",
    oceanSessionId: SESSION,
    cwd: os.tmpdir(),
    executable: file,
    guard: guardFor("claude", { approved: false }),
  });
  assert.equal(result.status, "denied");
  assert.doesNotMatch(result.output, /SHOULD-NOT-RUN/);
  assert.equal(result.guard.allowed, false);
});

test("consent rejection (revoked/expired/wrong-session) blocks provider invocation", async () => {
  const { file } = await fakeProvider(
    "#!/bin/sh\necho SHOULD-NOT-RUN\nexit 0\n",
  );
  const scope = {
    action: "provider.invoke",
    target: "claude",
    identifier: null,
    projectId: "ocean",
  };
  const foreignGrant = createGrant(
    "99999999-9999-9999-9999-999999999999",
    scope,
  );
  const result = await invokeProviderHeadless({
    provider: "claude",
    prompt: "x",
    oceanSessionId: SESSION,
    cwd: os.tmpdir(),
    executable: file,
    guard: {
      sessionId: SESSION,
      classification: classifyIntent("run the build"),
      scope,
      budget: BUDGET,
      grant: foreignGrant,
    },
  });
  assert.equal(result.status, "denied");
  assert.equal(result.guard.code, "wrong-session");
  assert.doesNotMatch(result.output, /SHOULD-NOT-RUN/);
});

test("ambiguous intent cannot invoke a provider even with a grant", async () => {
  const result = await invokeProviderHeadless({
    provider: "claude",
    prompt: "x",
    oceanSessionId: SESSION,
    cwd: os.tmpdir(),
    guard: guardFor("claude", {
      classification: classifyIntent("continue the login work"),
    }),
  });
  assert.equal(result.status, "denied");
  assert.equal(result.guard.code, "ambiguous-intent");
});

test("path/scope rejection: an invalid budget denies the invocation", async () => {
  const scope = {
    action: "provider.invoke",
    target: "claude",
    identifier: null,
    projectId: "ocean",
  };
  const result = await invokeProviderHeadless({
    provider: "claude",
    prompt: "x",
    oceanSessionId: SESSION,
    cwd: os.tmpdir(),
    guard: {
      sessionId: SESSION,
      classification: classifyIntent("run the build"),
      scope,
      budget: { maxFiles: 0 },
      grant: createGrant(SESSION, scope),
    },
  });
  assert.equal(result.status, "denied");
  assert.equal(result.guard.code, "invalid-budget");
});

// ---------------------------------------------------------------- failure modes (boundary, not compatibility)

test("invalid provider command produces a structured unavailable/failed result, never a throw", async () => {
  const result = await invokeProviderHeadless({
    provider: "claude",
    prompt: "x",
    oceanSessionId: SESSION,
    cwd: os.tmpdir(),
    executable: "/nonexistent/ocean-provider-binary",
    guard: guardFor("claude"),
  });
  assert.ok(["failed", "unavailable"].includes(result.status), result.status);
  assert.match(result.reason, /could not be executed|not available/);
});

unixOnly(
  "timeout produces a structured timeout result and kills the process",
  async () => {
    const { file } = await fakeProvider(
      "#!/usr/bin/env node\nsetTimeout(() => {}, 30_000);\n",
    );
    const started = Date.now();
    const result = await invokeProviderHeadless({
      provider: "claude",
      prompt: "x",
      oceanSessionId: SESSION,
      cwd: os.tmpdir(),
      executable: file,
      timeoutMs: 1_000,
      guard: guardFor("claude"),
    });
    assert.equal(result.status, "timeout");
    assert.ok(
      Date.now() - started < 15_000,
      "must not wait for the full sleep",
    );
  },
);

unixOnly(
  "non-zero exit produces a structured failed result with the exit code",
  async () => {
    const { file } = await fakeProvider(
      "#!/usr/bin/env node\nconsole.error('boom');\nprocess.exitCode = 3;\n",
    );
    const result = await invokeProviderHeadless({
      provider: "claude",
      prompt: "x",
      oceanSessionId: SESSION,
      cwd: os.tmpdir(),
      executable: file,
      guard: guardFor("claude"),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 3);
  },
);

test("malformed stream lines are counted, never thrown", () => {
  const parsed = parseProviderStream('{"a":1}\nNOT JSON\n{"b":2}\n');
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.malformedLines, 1);
  assert.equal(parsed.partial, false);
});

test("partial stream (unterminated final line) is reported as partial, not malformed", () => {
  const parsed = parseProviderStream('{"a":1}\n{"b":2');
  assert.equal(parsed.partial, true);
  assert.equal(parsed.malformedLines, 0);
  assert.equal(parsed.events.length, 1);
});

test("missing session id is reported as null rather than invented", () => {
  assert.equal(parseProviderStream('{"result":"ok"}').providerSessionId, null);
  assert.equal(
    parseProviderStream("plain provider prose", "text").providerSessionId,
    null,
  );
  assert.equal(
    parseProviderStream('{"session_id":"abc-123"}').providerSessionId,
    "abc-123",
  );
  assert.equal(
    parseProviderStream('{"session":{"id":"nested-1"}}').providerSessionId,
    "nested-1",
  );
});

test("a failing provider still propagates the Ocean session pointer and parent relation", async () => {
  const { file } = await fakeProvider("#!/bin/sh\nexit 4\n");
  const parent = randomUUID();
  const result = await invokeProviderHeadless({
    provider: "claude",
    prompt: "x",
    oceanSessionId: SESSION,
    parentSessionId: parent,
    cwd: os.tmpdir(),
    executable: file,
    guard: guardFor("claude"),
  });
  assert.equal(result.oceanSessionId, SESSION);
  assert.equal(result.parentSessionId, parent);
});

test("provider output is redacted and clipped — no credential leakage into results", async () => {
  // Composed at runtime so this public repo carries no credential-shaped literal in source.
  const fakeApiKey = ["sk", "ant", "secret123456"].join("-");
  const fakeToken = `ghp${"_"}abcdefghijklmnop`;
  const { file } = await fakeProvider(
    `#!/bin/sh\necho "API_KEY=${fakeApiKey}"\necho "token: ${fakeToken}"\nexit 0\n`,
  );
  const result = await invokeProviderHeadless({
    provider: "claude",
    prompt: "x",
    oceanSessionId: SESSION,
    cwd: os.tmpdir(),
    executable: file,
    guard: guardFor("claude"),
  });
  assert.ok(
    !result.output.includes(fakeApiKey),
    "api key must not survive redaction",
  );
  assert.ok(
    !result.output.includes(fakeToken),
    "token must not survive redaction",
  );
  assert.ok(result.output.length <= 4_000);
});

test("deterministic structured result: the same failure yields the same shape every time", async () => {
  const { file } = await fakeProvider("#!/bin/sh\nexit 7\n");
  const shape = (r) => ({
    provider: r.provider,
    status: r.status,
    exitCode: r.exitCode,
    partial: r.partial,
    malformed: r.malformedLines,
  });
  const first = await invokeProviderHeadless({
    provider: "claude",
    prompt: "x",
    oceanSessionId: SESSION,
    cwd: os.tmpdir(),
    executable: file,
    guard: guardFor("claude"),
  });
  const second = await invokeProviderHeadless({
    provider: "claude",
    prompt: "x",
    oceanSessionId: SESSION,
    cwd: os.tmpdir(),
    executable: file,
    guard: guardFor("claude"),
  });
  assert.deepEqual(shape(first), shape(second));
});

test("Arabic and English intents are guarded identically before provider invocation", async () => {
  const arabic = await invokeProviderHeadless({
    provider: "claude",
    prompt: "x",
    oceanSessionId: SESSION,
    cwd: os.tmpdir(),
    guard: guardFor("claude", {
      classification: classifyIntent("شغل السيرفر"),
      approved: false,
    }),
  });
  const english = await invokeProviderHeadless({
    provider: "claude",
    prompt: "x",
    oceanSessionId: SESSION,
    cwd: os.tmpdir(),
    guard: guardFor("claude", {
      classification: classifyIntent("run the build"),
      approved: false,
    }),
  });
  assert.equal(arabic.status, "denied");
  assert.equal(english.status, "denied");
  assert.equal(arabic.guard.code, english.guard.code);
});

// ---------------------------------------------------------------- hook & shim verification

installed(
  "live shim verification: the Ocean shim executes and routes through the engine",
  () => {
    const shim = path.join(
      os.homedir(),
      "ocean",
      SYSTEM_DIR,
      "runtime",
      "shims",
      "ocean",
    );
    const result = spawnSync(shim, ["context", "--json"], {
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const packet = JSON.parse(result.stdout);
    assert.ok(
      "projectResolution" in packet,
      "shim must reach the current engine build",
    );
  },
);

installed(
  "live hook verification: the Ocean SessionStart hook script executes and emits bounded context",
  async () => {
    const status = await claudeNativeHookStatus();
    assert.ok(
      status.scriptInstalled,
      `hook script missing: ${status.scriptPath}`,
    );
    const hook = status.scriptPath;
    const payload = JSON.stringify({
      cwd: os.tmpdir(),
      session_id: "slice10",
      hook_event_name: "SessionStart",
    });
    const result = spawnSync(hook, [], {
      input: payload,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    assert.ok(
      Buffer.byteLength(parsed.hookSpecificOutput.additionalContext) <= 256,
    );
  },
);

installed(
  "hook registration status is reported honestly, not assumed from the script's existence",
  async () => {
    const status = await claudeNativeHookStatus();
    assert.equal(status.scriptInstalled, true);
    assert.equal(typeof status.registered, "boolean");
    // Source inspection alone never proves registration: this reads the live settings file.
    assert.match(status.settingsPath, /\.claude\/settings\.json$/);
  },
);

installed(
  "CLI/direct-import parity: the shim and a direct engine call produce the same context packet",
  async (t) => {
    // The shim always execs the engine checkout it was installed against, while "direct"
    // runs whichever dist/main.js happens to be built in the invoking checkout. Both
    // resolve their project purely from OCEAN_ROOT and cwd, so pin those explicitly for
    // both invocations — otherwise this only passes by accident, when the suite happens
    // to run from inside the exact checkout the shim points at.
    const root = await mkdtemp(path.join(os.tmpdir(), "ocean-shim-parity-"));
    const env = { ...process.env, OCEAN_ROOT: root };
    const shim = path.join(
      os.homedir(),
      "ocean",
      SYSTEM_DIR,
      "runtime",
      "shims",
      "ocean",
    );
    // Parity means the same code reached two ways. From any other checkout (a worktree, a
    // branch ahead of the installed engine) the two runs are different versions, so skip.
    const shimTarget = readFileSync(shim, "utf8").match(
      /'([^']*main\.js)'/,
    )?.[1];
    if (
      !shimTarget ||
      realpathSync(shimTarget) !== realpathSync(path.resolve("dist/main.js"))
    ) {
      t.skip("the installed shim runs a different checkout");
      return;
    }
    const viaShim = spawnSync(shim, ["context", "--json"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    const direct = spawnSync(
      process.execPath,
      [path.resolve("dist/main.js"), "context", "--json"],
      { cwd: root, env, encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(viaShim.status, 0, viaShim.stderr);
    assert.equal(direct.status, 0, direct.stderr);
    const a = JSON.parse(viaShim.stdout);
    const b = JSON.parse(direct.stdout);
    assert.equal(a.project, b.project);
    assert.deepEqual(a.projectResolution, b.projectResolution);
  },
);

// ---------------------------------------------------------------- live provider smoke tests

live(
  "live smoke: claude headless completes and returns a provider session id",
  async () => {
    const executable = resolvesOrNull("claude");
    assert.ok(executable, "claude must resolve for this live test");
    const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-live-claude-"));
    const result = await invokeProviderHeadless({
      provider: "claude",
      prompt: "Reply with exactly: OK",
      oceanSessionId: SESSION,
      cwd: dir,
      timeoutMs: 180_000,
      guard: guardFor("claude"),
    });
    assert.equal(
      result.status,
      "completed",
      `${result.status}: ${result.reason} ${result.output}`,
    );
    assert.equal(result.exitCode, 0);
    assert.ok(
      result.providerSessionId,
      "claude headless json must carry a session id",
    );
    assert.equal(result.malformedLines, 0);
  },
);

live("live smoke: codex headless completes", async () => {
  const executable = resolvesOrNull("codex");
  assert.ok(executable, "codex must resolve for this live test");
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-live-codex-"));
  await mkdir(path.join(dir, ".git"), { recursive: true });
  const result = await invokeProviderHeadless({
    provider: "codex",
    prompt: "Reply with exactly: OK",
    oceanSessionId: SESSION,
    cwd: dir,
    timeoutMs: 300_000,
    guard: guardFor("codex"),
  });
  assert.equal(
    result.status,
    "completed",
    `${result.status}: ${result.reason} ${result.output}`,
  );
  assert.equal(result.exitCode, 0);
});

live("live smoke: gemini headless completes", async () => {
  const executable = resolvesOrNull("gemini");
  assert.ok(executable, "gemini must resolve for this live test");
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-live-gemini-"));
  const result = await invokeProviderHeadless({
    provider: "gemini",
    prompt: "Reply with exactly: OK",
    oceanSessionId: SESSION,
    cwd: dir,
    timeoutMs: 300_000,
    guard: guardFor("gemini"),
  });
  assert.equal(
    result.status,
    "completed",
    `${result.status}: ${result.reason} ${result.output}`,
  );
  assert.equal(result.exitCode, 0);
});

test("an unavailable provider is reported unavailable, never as a pass", async () => {
  const result = await invokeProviderHeadless({
    provider: "claude",
    prompt: "x",
    oceanSessionId: SESSION,
    cwd: os.tmpdir(),
    executable: path.join(os.tmpdir(), "definitely-missing-provider-binary"),
    guard: guardFor("claude"),
  });
  assert.notEqual(result.status, "completed");
});
