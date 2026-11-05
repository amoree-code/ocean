import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runProvider } from "../dist/infrastructure/providers/providers.js";

const unixOnly = process.platform === "win32" ? test.skip : test;

// A stand-in for Claude Code that ignores the SDK's stdin and answers per FAKE_MODE, which only
// reaches it through the run's child environment.
const fakeClaude = `#!/bin/sh
case "$FAKE_MODE" in
  ok) printf '{"type":"system","subtype":"init","session_id":"sess-1"}\\n{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"sess-1"}\\n' ;;
  sleep) sleep 5 & echo $! > "$FAKE_PIDFILE"; wait ;;
  big) i=0; while [ $i -lt 400 ]; do printf '{"type":"assistant","pad":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}\\n'; i=$((i+1)); done ;;
  error) printf '{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"sess-2"}\\n' ;;
  exit7) echo boom >&2; exit 7 ;;
  killed) kill -9 $$ ;;
  hugeline) head -c 20000 /dev/zero | tr '\\0' 'x'; sleep 5 ;;
  linger) sleep 5 & echo $! > "$FAKE_PIDFILE"; printf '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-3"}\\n' ;;
  text) printf 'fatal: plain crash notice\\n{"type":"result","subtype":"success","is_error":false,"session_id":"sess-5"}\\n'; printf 'tail without newline' ;;
  argv) for a in "$@"; do printf '%s\\n' "$a"; done > "$FAKE_ARGVFILE"; IFS= read -r init; printf '%s\\n' "$init" > "$FAKE_ARGVFILE.init"; printf '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-4"}\\n' ;;
esac
`;

async function withFakeClaude(body) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-claude-sdk-"));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "claude"), fakeClaude);
  await chmod(path.join(bin, "claude"), 0o755);
  const saved = { PATH: process.env.PATH, OCEAN_ROOT: process.env.OCEAN_ROOT };
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.OCEAN_ROOT = root;
  try {
    return await body(root);
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  }
}

const run = (root, mode, extra = {}) =>
  runProvider({
    provider: "claude",
    prompt: "hello",
    cwd: root,
    env: { FAKE_MODE: mode },
    timeoutMs: 10_000,
    ...extra,
  });

unixOnly(
  "Claude runs through the Agent SDK with the CLI provider contract",
  () =>
    withFakeClaude(async (root) => {
      const pids = [];
      const seen = [];
      const result = await run(root, "ok", {
        onSpawn: (pid) => pids.push(pid),
        onEvent: (event) => seen.push(event),
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(pids.length, 1);
      assert.deepEqual(
        result.events.map((event) => [event.type, event.data.type]),
        [
          ["json", "system"],
          ["json", "result"],
        ],
      );
      assert.equal(result.events[0].data.session_id, "sess-1");
      assert.deepEqual(seen, result.events);
    }),
);

unixOnly(
  "the SDK hands Claude Code the run's flags and its own system prompt",
  () =>
    withFakeClaude(async (root) => {
      const argvFile = path.join(root, "argv.txt");
      const result = await run(root, "argv", {
        env: { FAKE_MODE: "argv", FAKE_ARGVFILE: argvFile },
        readOnly: true,
        resumeId: "sess-9",
        model: "claude-test-model",
        readDirectories: ["/tmp/grant-a", "/tmp/grant-b"],
      });
      assert.equal(result.exitCode, 0, result.stderr);
      const argv = (await readFile(argvFile, "utf8")).trim().split("\n");
      const after = (flag) => argv[argv.indexOf(flag) + 1];
      // Read-only is enforced by Claude Code's own flags, not only asked for in the prompt.
      assert.equal(after("--permission-mode"), "plan");
      assert.ok(argv.includes("--restricted"));
      assert.ok(
        argv.includes("--resume=sess-9") || after("--resume") === "sess-9",
      );
      assert.equal(after("--model"), "claude-test-model");
      assert.deepEqual(
        argv.flatMap((arg, i) => (arg === "--add-dir" ? [argv[i + 1]] : [])),
        ["/tmp/grant-a", "/tmp/grant-b"],
      );
      // Claude Code's default system prompt, as `claude -p` runs it, never an empty one.
      const init = JSON.parse(await readFile(`${argvFile}.init`, "utf8"));
      assert.equal(init.request.subtype, "initialize");
      assert.notDeepEqual(init.request.systemPrompt, [""]);
      assert.notEqual(init.request.systemPrompt, "");
    }),
);

unixOnly("a Claude run past its timeout ends with 124", () =>
  withFakeClaude(async (root) => {
    const pidFile = path.join(root, "descendant.pid");
    const started = Date.now();
    // Long enough that the descendant has certainly started before the timeout stops it.
    const result = await run(root, "sleep", {
      timeoutMs: 1_500,
      env: { FAKE_MODE: "sleep", FAKE_PIDFILE: pidFile },
    });
    assert.equal(result.exitCode, 124);
    assert.match(result.stderr, /Process timed out/);
    assert.ok(Date.now() - started < 4_000, "the run ends at its timeout");
    // The whole process group is stopped, not just the leader.
    const descendant = Number((await readFile(pidFile, "utf8")).trim());
    assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
  }),
);

unixOnly("a Claude run over its output budget ends with 125", () =>
  withFakeClaude(async (root) => {
    const result = await run(root, "big", { maxOutputBytes: 2_000 });
    assert.equal(result.exitCode, 125);
    assert.match(result.stderr, /Output budget exceeded/);
    assert.ok(result.events.length < 400);
  }),
);

unixOnly("an error result or a non-zero exit fails the Claude run", () =>
  withFakeClaude(async (root) => {
    assert.equal((await run(root, "error")).exitCode, 1);
    const crashed = await run(root, "exit7");
    assert.equal(crashed.exitCode, 7);
    assert.match(crashed.stderr, /boom/);
  }),
);

unixOnly(
  "a Claude process killed by a signal is a failed run, not a success",
  () =>
    withFakeClaude(async (root) => {
      assert.equal((await run(root, "killed")).exitCode, 1);
    }),
);

unixOnly(
  "one huge unterminated line trips the output budget as it arrives",
  () =>
    withFakeClaude(async (root) => {
      const started = Date.now();
      const result = await run(root, "hugeline", { maxOutputBytes: 4_000 });
      assert.equal(result.exitCode, 125);
      assert.ok(Date.now() - started < 4_000, "stopped before the line ends");
    }),
);

unixOnly(
  "a background process left holding the output does not keep a finished run open",
  () =>
    withFakeClaude(async (root) => {
      const pidFile = path.join(root, "linger.pid");
      const started = Date.now();
      // Claude exits 0 with its result; the descendant would hold the pipes for 5 s.
      const result = await run(root, "linger", {
        timeoutMs: 20_000,
        env: { FAKE_MODE: "linger", FAKE_PIDFILE: pidFile },
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.ok(Date.now() - started < 3_500, "the run ends once Claude has");
      const descendant = Number((await readFile(pidFile, "utf8")).trim());
      // The group was SIGKILLed as the run ended. Wait at most 1 s: the run ended inside 3.5 s, so
      // the check ends before the descendant's own `sleep 5` could, and a survivor still fails.
      assert.ok(
        await isGoneWithin(descendant, 1_000),
        "the descendant died with the group",
      );
    }),
);

// A SIGKILLed process can still answer kill(pid, 0) briefly: until the signal lands, and then as a
// zombie until its new parent reaps it (slower on ubuntu-26.04 runners). Neither is running.
async function isGoneWithin(pid, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
    const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    }).stdout.trim();
    if (state === "" || state.startsWith("Z")) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

unixOnly("plain-text stdout lines are kept as text events", () =>
  withFakeClaude(async (root) => {
    const result = await run(root, "text");
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(
      result.events.map((event) => [event.type, event.data.type ?? event.data]),
      [
        ["text", "fatal: plain crash notice"],
        ["json", "result"],
        ["text", "tail without newline"],
      ],
    );
  }),
);

unixOnly("a Claude that cannot start rejects the run", () =>
  withFakeClaude(async (root) => {
    await writeFile(
      path.join(root, "bin", "claude"),
      "#!/no/such/interpreter\n",
    );
    await assert.rejects(run(root, "ok"), { code: "ENOENT" });
  }),
);

unixOnly("many concurrent runs share one set of process listeners", () =>
  withFakeClaude(async (root) => {
    const warnings = [];
    const onWarning = (warning) => warnings.push(warning.name);
    process.on("warning", onWarning);
    const before = process.listenerCount("SIGINT");
    try {
      const results = await Promise.all(
        Array.from({ length: 14 }, () => run(root, "ok")),
      );
      assert.ok(results.every((result) => result.exitCode === 0));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(warnings, []);
      assert.equal(process.listenerCount("SIGINT"), before);
    } finally {
      process.off("warning", onWarning);
    }
  }),
);

unixOnly("a stopped run leaves no timer behind", () =>
  withFakeClaude(async (root) => {
    const timers = () =>
      process.getActiveResourcesInfo().filter((name) => name === "Timeout")
        .length;
    const before = timers();
    const result = await run(root, "sleep", {
      timeoutMs: 300,
      env: { FAKE_MODE: "sleep", FAKE_PIDFILE: path.join(root, "t.pid") },
    });
    assert.equal(result.exitCode, 124);
    assert.equal(timers(), before);
  }),
);

unixOnly("a Ctrl+C to Ocean ends the Claude run's whole process group", () =>
  withFakeClaude(async (root) => {
    const pidFile = path.join(root, "interrupted.pid");
    const code = `
const { runProvider } = await import("./dist/infrastructure/providers/providers.js");
await runProvider({ provider: "claude", prompt: "x", cwd: process.env.ROOT, timeoutMs: 20000, env: { FAKE_MODE: "sleep", FAKE_PIDFILE: process.env.PIDFILE } });
`;
    const ocean = spawn(process.execPath, ["--input-type=module", "-e", code], {
      // The package dir, wherever the suite is run from: the child imports `./dist`.
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, ROOT: root, PIDFILE: pidFile },
      stdio: "ignore",
    });
    const deadline = Date.now() + 10_000;
    while (!existsSync(pidFile) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    const descendant = Number((await readFile(pidFile, "utf8")).trim());
    ocean.kill("SIGINT");
    const [, signal] = await once(ocean, "exit");
    assert.equal(signal, "SIGINT", "Ocean still ends the way Ctrl+C ends it");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
  }),
);
