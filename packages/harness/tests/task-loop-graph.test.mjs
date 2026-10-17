import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PROJECTS_DIR, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import {
  FileCheckpointSaver,
  iterationGraph,
  keepRunsLocal,
} from "@ocean/loop/loops/iteration-graph.js";
import {
  listTaskLoops,
  runTaskLoopsOnce,
  startTaskLoop,
  stopTaskLoop,
} from "@ocean/loop/loops/task-loop.js";
import { createAgentRuntime } from "../dist/composition/runtime.js";

// A workspace with one project task that claims done, so an iteration runs work → verify →
// record.
async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-loop-graph-"));
  const repo = await mkdtemp(path.join(os.tmpdir(), "ocean-loop-graph-repo-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "writer.json"),
    JSON.stringify({
      name: "writer",
      provider: "claude",
      model: "sonnet",
      role: "writer",
      writePolicy: "workspace",
    }),
  );
  const shop = path.join(root, PROJECTS_DIR, "shop");
  await mkdir(path.join(shop, "tasks", "T-101"), { recursive: true });
  await writeFile(
    path.join(shop, "project.json"),
    JSON.stringify({ name: "shop", paths: [repo] }),
  );
  await writeFile(
    path.join(shop, "tasks", "T-101", "task.md"),
    "---\nid: T-101\ntitle: x\nstate: done\nproject: shop\n---\n\n## Next action\n\nx\n\n## Verification\n\n`pnpm test`\n\n## Log\n\n",
  );
  return { root, repo, marker: path.join(root, "provider-runs") };
}

async function withRoot(root, body) {
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

const countingRuntime = () => {
  const calls = { provider: 0 };
  const runtime = createAgentRuntime({
    executeProvider: async () => {
      calls.provider += 1;
      return { exitCode: 0, events: [], stderr: "" };
    },
  });
  return { calls, runtime };
};

// Runs one loop pass in a separate process that dies inside verify — after the agent session
// finished and its step was checkpointed, before anything reached loops.json.
function crashInVerify({ root, repo, marker }) {
  const code = `
import { appendFileSync } from "node:fs";
import { runTaskLoopsOnce } from "@ocean/loop/loops/task-loop.js";
import { createAgentRuntime } from "./dist/composition/runtime.js";
const runtime = createAgentRuntime({
  executeProvider: async () => {
    appendFileSync(process.env.MARKER, "run\\n");
    return { exitCode: 0, events: [], stderr: "" };
  },
});
await runTaskLoopsOnce(process.env.REPO, runtime, { verifyRun: async () => process.exit(9) });
`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: path.resolve("."),
    env: { ...process.env, OCEAN_ROOT: root, REPO: repo, MARKER: marker },
    encoding: "utf8",
  });
}

const checkpointDir = (root) => path.join(root, SYSTEM_DIR, "loop-checkpoints");
const hasThread = (root, id) =>
  existsSync(path.join(checkpointDir(root), `${id}.json`));
const startLoop = (ws, extra = {}) =>
  startTaskLoop({
    taskId: "T-101",
    profile: "writer",
    prompt: "work",
    cwd: ws.repo,
    approved: true,
    ...extra,
  });
const taskFile = (root) =>
  path.join(root, PROJECTS_DIR, "shop", "tasks", "T-101", "task.md");

async function inWorkspace(body) {
  const ws = await workspace();
  try {
    await withRoot(ws.root, () => body(ws));
  } finally {
    await rm(ws.root, { recursive: true, force: true });
    await rm(ws.repo, { recursive: true, force: true });
  }
}

test("an iteration the process died in resumes at its step without re-running the agent", () =>
  inWorkspace(async (ws) => {
    const loop = await startLoop(ws);
    const crashed = crashInVerify(ws);
    assert.equal(crashed.status, 9, crashed.stderr);
    assert.equal(await readFile(ws.marker, "utf8"), "run\n");
    assert.equal((await listTaskLoops())[0].iterations, 0);
    assert.ok(hasThread(ws.root, loop.id));

    const { calls, runtime } = countingRuntime();
    const ran = await runTaskLoopsOnce(ws.repo, runtime, {
      verifyRun: async () => ({ exitCode: 0 }),
    });
    assert.deepEqual(ran, [loop.id]);
    assert.equal(calls.provider, 0, "the finished session is not run again");
    const [after] = await listTaskLoops();
    assert.equal(after.status, "completed");
    assert.equal(after.iterations, 1);
    assert.equal(after.failures, 0);
    assert.equal(hasThread(ws.root, loop.id), false);
  }));

test("a loop stopped after a crash drops its interrupted iteration", () =>
  inWorkspace(async (ws) => {
    const loop = await startLoop(ws);
    assert.equal(crashInVerify(ws).status, 9);
    await stopTaskLoop(loop.id);
    const { calls, runtime } = countingRuntime();
    assert.deepEqual(
      await runTaskLoopsOnce(ws.repo, runtime, {
        verifyRun: async () => ({ exitCode: 0 }),
      }),
      [],
    );
    assert.equal(calls.provider, 0);
    assert.equal((await listTaskLoops())[0].status, "stopped");
    assert.equal(hasThread(ws.root, loop.id), false);
  }));

test("an iteration that finished but never reached loops.json is taken, not run again", () =>
  inWorkspace(async (ws) => {
    const loop = await startLoop(ws);
    // Leave a finished thread behind, as a process that died right after the graph returned would.
    const saver = await FileCheckpointSaver.open(checkpointDir(ws.root));
    const finished = {
      ...loop,
      iterations: 1,
      status: "completed",
      lastSessionId: "s-1",
    };
    const graph = iterationGraph(
      {
        work: async () => ({ loop: finished, next: "end" }),
        verify: async (current) => current,
        record: async (current) => current,
      },
      saver,
    );
    await graph.invoke(
      { loop, ran: false },
      { configurable: { thread_id: loop.id }, durability: "sync" },
    );
    assert.ok(hasThread(ws.root, loop.id));

    const { calls, runtime } = countingRuntime();
    assert.deepEqual(await runTaskLoopsOnce(ws.repo, runtime), []);
    assert.equal(calls.provider, 0);
    const [after] = await listTaskLoops();
    assert.equal(after.status, "completed");
    assert.equal(after.iterations, 1);
    assert.equal(after.lastSessionId, "s-1");
    assert.equal(hasThread(ws.root, loop.id), false);
  }));

test("a failing verify is one failed attempt, run once, and the next pass starts fresh", () =>
  inWorkspace(async (ws) => {
    const loop = await startLoop(ws, { intervalMs: 1_000, maxAttempts: 2 });
    const { calls, runtime } = countingRuntime();
    let verifies = 0;
    const ran = await runTaskLoopsOnce(ws.repo, runtime, {
      verifyRun: async () => {
        verifies += 1;
        throw new Error("verifier unavailable");
      },
    });
    assert.deepEqual(ran, []);
    assert.equal(calls.provider, 1);
    assert.equal(verifies, 1, "a task's checks are never re-run in place");
    const [after] = await listTaskLoops();
    assert.equal(after.status, "active");
    assert.equal(after.iterations, 1);
    assert.equal(after.failures, 1);
    assert.equal(after.lastError, "verifier unavailable");
    assert.equal(hasThread(ws.root, loop.id), false);
  }));

test("record retries a filesystem error quietly and leaves no duplicate task note", () =>
  inWorkspace(async (ws) => {
    const loop = await startLoop(ws, { maxAttempts: 2 });
    // bridge/runs as a file: every result write fails with a filesystem error.
    await writeFile(path.join(ws.root, SYSTEM_DIR, "runs"), "");
    const printed = [];
    const log = console.log;
    console.log = (...args) => printed.push(args.join(" "));
    try {
      const { calls, runtime } = countingRuntime();
      await runTaskLoopsOnce(ws.repo, runtime, {
        verifyRun: async () => ({ exitCode: 0 }),
      });
      assert.equal(calls.provider, 1);
    } finally {
      console.log = log;
    }
    assert.deepEqual(printed, [], "retries write nothing to stdout");
    const [after] = await listTaskLoops();
    assert.equal(after.failures, 1);
    assert.match(after.lastError, /EEXIST|ENOTDIR/);
    assert.doesNotMatch(
      await readFile(taskFile(ws.root), "utf8"),
      /iteration 1/,
    );
    assert.equal(hasThread(ws.root, loop.id), false);
  }));

test("an unreadable checkpoint is set aside and the loop still runs", () =>
  inWorkspace(async (ws) => {
    const loop = await startLoop(ws);
    await mkdir(checkpointDir(ws.root), { recursive: true });
    await writeFile(
      path.join(checkpointDir(ws.root), `${loop.id}.json`),
      "{ not json",
    );
    const { calls, runtime } = countingRuntime();
    assert.deepEqual(
      await runTaskLoopsOnce(ws.repo, runtime, {
        verifyRun: async () => ({ exitCode: 0 }),
      }),
      [loop.id],
    );
    assert.equal(calls.provider, 1);
    assert.ok(
      (await readdir(checkpointDir(ws.root))).some((name) =>
        name.startsWith(`${loop.id}.json.unreadable-`),
      ),
    );
  }));

test("loop runs turn off only the LangSmith tracing that is on", () => {
  const env = { LANGSMITH_TRACING: "true", LANGCHAIN_TRACING_V2: "false" };
  keepRunsLocal(env);
  assert.deepEqual(env, {
    LANGSMITH_TRACING: "false",
    LANGCHAIN_TRACING_V2: "false",
  });
});
