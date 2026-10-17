import assert from "node:assert/strict";
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
