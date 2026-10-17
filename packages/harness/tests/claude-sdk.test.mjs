import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  "a descendant holding the output open cannot outlive the run's timeout",
  () =>
    withFakeClaude(async (root) => {
      const pidFile = path.join(root, "linger.pid");
      const started = Date.now();
      const result = await run(root, "linger", {
        timeoutMs: 1_500,
        env: { FAKE_MODE: "linger", FAKE_PIDFILE: pidFile },
      });
      assert.equal(result.exitCode, 124);
      assert.ok(Date.now() - started < 4_000);
      const descendant = Number((await readFile(pidFile, "utf8")).trim());
      assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
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
      cwd: path.resolve("."),
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
