import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { actionFingerprint } from "@ocean/core/domain/mcp/mcp-contract.js";
import { SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import {
  createWebhookGateway as createWebhookGatewayRaw,
  handleGatewayRequest as handleGatewayRequestRaw,
  telegramAdapter,
} from "../dist/application/gateway/webhook-gateway.js";
import {
  listSchedules,
  runDueSchedules as runDueSchedulesRaw,
  runSchedulerWorkerOnce as runSchedulerWorkerOnceRaw,
  runSchedulerWorker as runSchedulerWorkerRaw,
  saveSchedule,
} from "../dist/application/scheduler/local-scheduler.js";
import { createAgentRuntime } from "../dist/composition/runtime.js";
import { restartService } from "../dist/infrastructure/process/service.js";

// Test shims: scheduler/gateway now take an AgentRuntimeDeps bag; wrap a bare
// provider executor into a runtime so the test bodies keep passing an executor.
const rt = (execute) =>
  createAgentRuntime(execute ? { executeProvider: execute } : {});
const runDueSchedules = (cwd, execute) => runDueSchedulesRaw(cwd, rt(execute));
const runSchedulerWorkerOnce = (cwd, execute) =>
  runSchedulerWorkerOnceRaw(cwd, rt(execute));
const runSchedulerWorker = (cwd, options) =>
  runSchedulerWorkerRaw(cwd, rt(), options);
const handleGatewayRequest = (input, token, expected, cwd, execute) =>
  handleGatewayRequestRaw(input, token, expected, cwd, rt(execute));
const createWebhookGateway = (cwd, secret, execute) =>
  createWebhookGatewayRaw(cwd, secret, rt(execute));

const mainScript = path.join(import.meta.dirname, "..", "dist", "main.js");

test("service stays running until signaled, then exits cleanly", async () => {
  const child = spawn(process.execPath, [mainScript, "service"], {
    stdio: "pipe",
    env:
      process.platform === "win32"
        ? { ...process.env, OCEAN_SERVICE_TEST_SHUTDOWN_MS: "100" }
        : process.env,
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  // Wait for the readiness line rather than a fixed sleep: it is printed once the signal
  // handlers are installed, so SIGTERM can never land during startup under load.
  const deadline = Date.now() + 20_000;
  while (!/Ocean runtime is running/.test(stdout) && Date.now() < deadline)
    await delay(20);
  assert.match(stdout, /Ocean runtime is running/);
  assert.equal(
    child.exitCode,
    null,
    "service exited before receiving a shutdown signal",
  );

  const exited = new Promise((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  if (process.platform === "win32") await delay(150);
  else child.kill("SIGTERM");
  const code = await exited;

  assert.equal(code, 0);
  assert.match(stdout, /Ocean runtime is running/);
  assert.match(stdout, /Ocean runtime stopped/);
});

// T-305: the always-on service runs the daily pull too, so a Desktop-only user is pulled.
test("service starts the daily pull; OCEAN_NO_PULL_ON_START=1 turns it off", async () => {
  const runService = async (extra) => {
    const base = await mkdtemp(path.join(os.tmpdir(), "ocean-service-pull-"));
    const root = path.join(base, "root");
    const home = path.join(base, "home");
    await mkdir(root, { recursive: true });
    await mkdir(home, { recursive: true });
    // clear-ocean-env turns the pull off for every spawned process; this test owns the switch.
    const { OCEAN_NO_PULL_ON_START: _off, ...inherited } = process.env;
    const child = spawn(process.execPath, [mainScript, "service"], {
      stdio: "ignore",
      env: {
        ...inherited,
        HOME: home,
        USERPROFILE: home,
        OCEAN_ROOT: root,
        OCEAN_SERVICE_TEST_SHUTDOWN_MS: "8000",
        ...extra,
      },
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const stamp = path.join(root, SYSTEM_DIR, "state", "pull", "last.json");
    const deadline = Date.now() + 20_000;
    let pulled = false;
    while (!pulled && Date.now() < deadline) {
      pulled = await stat(stamp).then(
        () => true,
        () => false,
      );
      if (!pulled && child.exitCode !== null) break;
      if (!pulled) await delay(100);
    }
    await exited;
    return pulled;
  };
  assert.equal(await runService({}), true);
  assert.equal(await runService({ OCEAN_NO_PULL_ON_START: "1" }), false);
});

test("restartService reloads the installed service, says when there is none, and never throws", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocean-service-restart-"));
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args].join(" "));
  };
  assert.equal(
    await restartService({ home, platform: "darwin", run }),
    "not-installed",
  );
  assert.equal(
    await restartService({ home, platform: "linux", run }),
    "not-installed",
  );
  assert.deepEqual(calls, []);
  const plist = path.join(
    home,
    "Library",
    "LaunchAgents",
    "com.ocean.runtime.plist",
  );
  const unit = path.join(home, ".config", "systemd", "user", "ocean.service");
  for (const file of [plist, unit]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "");
  }
  assert.equal(
    await restartService({ home, platform: "darwin", run }),
    "restarted",
  );
  assert.match(calls[0], /^launchctl bootout gui\/\S*\/com\.ocean\.runtime$/);
  assert.equal(
    calls[1],
    `launchctl bootstrap ${calls[1].split(" ")[2]} ${plist}`,
  );
  calls.length = 0;
  assert.equal(
    await restartService({ home, platform: "linux", run }),
    "restarted",
  );
  assert.deepEqual(calls, [
    "systemctl --user daemon-reload",
    "systemctl --user try-restart ocean.service",
  ]);
  const failing = async () => {
    throw new Error("Operation not permitted");
  };
  const failed = await restartService({
    home,
    platform: "darwin",
    run: failing,
  });
  assert.match(
    failed.failed,
    /^Operation not permitted — the service is stopped; start it with: launchctl bootstrap gui\/\S* /,
  );
  assert.ok(failed.failed.endsWith(plist));
});

test("persists and runs a due local schedule once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-schedule-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "default.json"),
    JSON.stringify({
      name: "default",
      provider: "claude",
      model: "sonnet",
      role: "assistant",
    }),
  );
  process.env.OCEAN_ROOT = root;
  await saveSchedule({
    id: "brief",
    profile: "default",
    prompt: "brief",
    intervalMs: 1000,
    nextRunAt: new Date(0).toISOString(),
    enabled: true,
  });
  assert.deepEqual(
    await runDueSchedules(root, async () => ({
      exitCode: 0,
      events: [],
      stderr: "",
    })),
    ["brief"],
  );
  assert.equal(
    (await listSchedules())[0].nextRunAt > new Date(0).toISOString(),
    true,
  );
  delete process.env.OCEAN_ROOT;
});

test("run-due uses a cross-process lease for concurrent callers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-schedule-lease-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "default.json"),
    JSON.stringify({
      name: "default",
      provider: "claude",
      model: "sonnet",
      role: "assistant",
    }),
  );
  process.env.OCEAN_ROOT = root;
  await saveSchedule({
    id: "once",
    profile: "default",
    prompt: "once",
    intervalMs: 1000,
    nextRunAt: new Date(0).toISOString(),
    enabled: true,
  });
  let executions = 0;
  const execute = async () => {
    executions += 1;
    await delay(25);
    return { exitCode: 0, events: [], stderr: "" };
  };
  const results = await Promise.all([
    runDueSchedules(root, execute),
    runDueSchedules(root, execute),
  ]);
  assert.equal(executions, 1);
  assert.equal(results.flat().filter((id) => id === "once").length, 1);
  delete process.env.OCEAN_ROOT;
});

test("scheduler completion merges with concurrent schedule edits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-schedule-merge-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "default.json"),
    JSON.stringify({ name: "default", provider: "claude", role: "assistant" }),
  );
  process.env.OCEAN_ROOT = root;
  try {
    await saveSchedule({
      id: "running",
      profile: "default",
      prompt: "run",
      intervalMs: 1000,
      nextRunAt: new Date(0).toISOString(),
      enabled: true,
    });
    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const run = runDueSchedules(root, async () => {
      await blocked;
      return { exitCode: 0, events: [], stderr: "" };
    });
    await delay(20);
    await saveSchedule({
      id: "added",
      profile: "default",
      prompt: "later",
      intervalMs: 1000,
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      enabled: true,
    });
    release();
    await run;
    assert.deepEqual((await listSchedules()).map((item) => item.id).sort(), [
      "added",
      "running",
    ]);
  } finally {
    delete process.env.OCEAN_ROOT;
  }
});

test("gateway authenticates and triggers a bounded run request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-gateway-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "default.json"),
    JSON.stringify({
      name: "default",
      provider: "claude",
      model: "sonnet",
      role: "assistant",
    }),
  );
  process.env.OCEAN_ROOT = root;
  const result = await handleGatewayRequest(
    {
      profile: "default",
      prompt: "ping",
      approval: {
        approved: true,
        fingerprint: actionFingerprint("gateway.run", {
          profile: "default",
          prompt: "ping",
        }),
      },
    },
    "secret",
    "secret",
    root,
    async () => ({ exitCode: 0, events: [], stderr: "" }),
  );
  assert.equal(result.status, 200);
  assert.equal(
    (await handleGatewayRequest({}, "wrong", "secret", root)).status,
    401,
  );
  delete process.env.OCEAN_ROOT;
});

test("normalizes Telegram-shaped messages without credentials or implicit approval", () => {
  const result = telegramAdapter.normalize({
    message: {
      message_id: 7,
      chat: { id: 42 },
      text: "/run developer fix tests",
    },
  });
  assert.deepEqual(result, {
    platform: "telegram",
    externalId: "42:7",
    profile: "developer",
    prompt: "fix tests",
    approved: false,
  });
});

test("gateway binds identities and profile scopes to the exact approved request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-gateway-scope-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "default.json"),
    JSON.stringify({
      name: "default",
      provider: "claude",
      model: "sonnet",
      role: "assistant",
    }),
  );
  process.env.OCEAN_ROOT = root;
  const approval = {
    approved: true,
    fingerprint: actionFingerprint("gateway.run", {
      profile: "default",
      prompt: "ping",
    }),
  };
  assert.equal(
    (
      await handleGatewayRequest(
        { profile: "default", prompt: "ping", approval },
        "worker-token",
        "worker@default=worker-token",
        root,
        async () => ({ exitCode: 0, events: [], stderr: "" }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await handleGatewayRequest(
        { profile: "other", prompt: "ping", approval },
        "worker-token",
        "worker@default=worker-token",
        root,
      )
    ).status,
    401,
  );
  delete process.env.OCEAN_ROOT;
});

test("gateway rejects traversal profiles and hides profile loading errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-gateway-security-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, "outside.json"),
    JSON.stringify({
      name: "outside",
      provider: "claude",
      model: "sonnet",
      role: "outside",
    }),
  );
  process.env.OCEAN_ROOT = root;
  const profile = "../outside";
  const approval = {
    approved: true,
    fingerprint: actionFingerprint("gateway.run", { profile, prompt: "ping" }),
  };
  const result = await handleGatewayRequest(
    { profile, prompt: "ping", approval },
    "secret",
    "secret",
    root,
  );
  assert.equal(result.status, 400);
  assert.equal(result.body, "Invalid profile");
  delete process.env.OCEAN_ROOT;
});

test("HTTP gateway rate limiting persists across requests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-gateway-rate-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "default.json"),
    JSON.stringify({ name: "default", provider: "claude", role: "assistant" }),
  );
  process.env.OCEAN_ROOT = root;
  const gateway = createWebhookGateway(root, "secret", async () => ({
    exitCode: 0,
    events: [],
    stderr: "",
  }));
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  try {
    const address = gateway.address();
    assert.ok(address && typeof address === "object");
    const input = {
      profile: "default",
      prompt: "ping",
      approval: {
        approved: true,
        fingerprint: actionFingerprint("gateway.run", {
          profile: "default",
          prompt: "ping",
        }),
      },
    };
    const statuses = [];
    for (let index = 0; index < 11; index += 1) {
      const response = await fetch(`http://127.0.0.1:${address.port}`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
    assert.equal(statuses[10], 429);
  } finally {
    await new Promise((resolve) => gateway.close(resolve));
    delete process.env.OCEAN_ROOT;
  }
});

test("scheduler worker records retry state and releases its lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-worker-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "default.json"),
    JSON.stringify({
      name: "default",
      provider: "claude",
      model: "sonnet",
      role: "assistant",
    }),
  );
  process.env.OCEAN_ROOT = root;
  await saveSchedule({
    id: "retry",
    profile: "default",
    prompt: "retry",
    intervalMs: 1000,
    nextRunAt: new Date(0).toISOString(),
    enabled: true,
  });
  await runSchedulerWorkerOnce(root, async () => {
    throw new Error("provider failed");
  });
  assert.equal((await listSchedules())[0].attempts, 1);
  delete process.env.OCEAN_ROOT;
});

test("scheduler worker retries a provider non-zero exit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-worker-exit-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "default.json"),
    JSON.stringify({ name: "default", provider: "claude", role: "assistant" }),
  );
  process.env.OCEAN_ROOT = root;
  try {
    await saveSchedule({
      id: "failed-exit",
      profile: "default",
      prompt: "retry",
      intervalMs: 1000,
      nextRunAt: new Date(0).toISOString(),
      enabled: true,
    });
    assert.deepEqual(
      await runSchedulerWorkerOnce(root, async () => ({
        exitCode: 1,
        events: [],
        stderr: "failed",
      })),
      [],
    );
    assert.equal((await listSchedules())[0].attempts, 1);
  } finally {
    delete process.env.OCEAN_ROOT;
  }
});

test("scheduler worker reclaims a lease owned by a dead process", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ocean-worker-stale-lease-"),
  );
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await mkdir(path.join(root, SYSTEM_DIR, "schedules"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "default.json"),
    JSON.stringify({ name: "default", provider: "claude", role: "assistant" }),
  );
  process.env.OCEAN_ROOT = root;
  try {
    await saveSchedule({
      id: "stale",
      profile: "default",
      prompt: "run",
      intervalMs: 1000,
      nextRunAt: new Date(0).toISOString(),
      enabled: true,
    });
    await writeFile(
      path.join(root, SYSTEM_DIR, "schedules", "stale.lease"),
      "99999999\n",
    );
    assert.deepEqual(
      await runSchedulerWorkerOnce(root, async () => ({
        exitCode: 0,
        events: [],
        stderr: "",
      })),
      ["stale"],
    );
  } finally {
    delete process.env.OCEAN_ROOT;
  }
});

test("scheduler worker stops through AbortSignal", async () => {
  const controller = new AbortController();
  controller.abort();
  await runSchedulerWorker("/tmp", {
    signal: controller.signal,
    pollMs: 1_000,
  });
});
