import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  runHeadless,
} from "../dist/infrastructure/process/cli-process.js";

test("streams structured and plain headless output", async () => {
  const result = await runHeadless({
    command: process.execPath,
    args: [
      "-e",
      "console.log(JSON.stringify({type:'delta',text:'ok'})); console.log('done')",
    ],
    cwd: process.cwd(),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.events, [
    { type: "json", data: { type: "delta", text: "ok" } },
    { type: "text", data: "done" },
  ]);
});

test("terminates a headless process that exceeds its limit", async () => {
  const result = await runHeadless({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 5000)"],
    cwd: process.cwd(),
    timeoutMs: 10,
  });

  assert.equal(result.exitCode, 124);
  assert.match(result.stderr, /timed out/);
});

test("escalates when a headless child ignores SIGTERM", async () => {
  const result = await runHeadless({
    command: process.execPath,
    args: ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 5000)"],
    cwd: process.cwd(),
    timeoutMs: 10,
  });

  assert.equal(result.exitCode, 124);
  assert.match(result.stderr, /timed out/);
});

test("terminates a headless process that exceeds its output budget", async () => {
  const result = await runHeadless({
    command: process.execPath,
    args: ["-e", "console.log('0123456789')"],
    cwd: process.cwd(),
    maxOutputBytes: 4,
  });

  assert.equal(result.exitCode, 125);
  assert.match(result.stderr, /Output budget exceeded/);
});

test("exports a bounded, sane default output budget", () => {
  // Previously runHeadless defaulted to Number.MAX_SAFE_INTEGER when the caller passed no
  // maxOutputBytes (e.g. a provider run with no run-contract budget), allowing effectively
  // unbounded stdout/stderr capture. It must now be a real, finite ceiling.
  assert.ok(DEFAULT_MAX_OUTPUT_BYTES > 0);
  assert.ok(DEFAULT_MAX_OUTPUT_BYTES < Number.MAX_SAFE_INTEGER);
  assert.ok(DEFAULT_MAX_OUTPUT_BYTES <= 256 * 1024 * 1024);
});

test("applies the default output budget when the caller passes none", async () => {
  // Newline-delimited so runHeadless's line buffer stays small chunk-to-chunk instead of
  // re-splitting one ever-growing multi-megabyte string.
  const lineCount = Math.ceil(DEFAULT_MAX_OUTPUT_BYTES / 1024) + 1;
  const result = await runHeadless({
    command: process.execPath,
    args: [
      "-e",
      `process.stdout.write(("x".repeat(1023) + "\\n").repeat(${lineCount}))`,
    ],
    cwd: process.cwd(),
  });

  assert.equal(result.exitCode, 125);
  assert.match(result.stderr, /Output budget exceeded/);
});

test("counts stderr against the same output budget as stdout", async () => {
  const result = await runHeadless({
    command: process.execPath,
    args: ["-e", "process.stderr.write('0123456789')"],
    cwd: process.cwd(),
    maxOutputBytes: 4,
  });

  assert.equal(result.exitCode, 125);
  assert.match(result.stderr, /Output budget exceeded/);
});

const unixOnly = process.platform === "win32" ? test.skip : test;

// A shell that starts a background `sleep` holding the pipes, records its pid, then runs on.
const withDescendant = (pidFile, tail) => [
  "-c",
  `sleep 5 & echo $! > "${pidFile}"; ${tail}`,
];
// A killed process is gone once its parent (init) has reaped it, a moment after the signal.
async function assertGone(pidFile) {
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`process ${pid} is still running`);
}
const pidFileIn = () =>
  path.join(os.tmpdir(), `ocean-headless-${process.pid}-${Date.now()}.pid`);

unixOnly(
  "a timeout stops the whole process group, not just the leader",
  async () => {
    const pidFile = pidFileIn();
    const started = Date.now();
    const result = await runHeadless({
      command: "/bin/sh",
      args: withDescendant(pidFile, "wait"),
      cwd: process.cwd(),
      timeoutMs: 1_000,
    });
    assert.equal(result.exitCode, 124);
    assert.ok(Date.now() - started < 3_500, "the run ends at its timeout");
    await assertGone(pidFile);
  },
);

unixOnly(
  "a finished process does not stay open for a background child holding its output",
  async () => {
    const pidFile = pidFileIn();
    const started = Date.now();
    const result = await runHeadless({
      command: "/bin/sh",
      args: withDescendant(pidFile, "echo done"),
      cwd: process.cwd(),
      timeoutMs: 20_000,
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.events, [{ type: "text", data: "done" }]);
    assert.ok(
      Date.now() - started < 3_500,
      "the run ends once the process has",
    );
    await assertGone(pidFile);
  },
);

test("a command that cannot start rejects the run", async () => {
  await assert.rejects(
    runHeadless({
      command: "/no/such/command",
      args: [],
      cwd: process.cwd(),
    }),
    { code: "ENOENT" },
  );
});

test("a process ended by a signal is a failed run", async () => {
  const result = await runHeadless({
    command: process.execPath,
    args: ["-e", "process.kill(process.pid, 'SIGKILL')"],
    cwd: process.cwd(),
  });
  assert.equal(result.exitCode, 1);
});
