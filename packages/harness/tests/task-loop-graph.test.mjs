import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PROJECTS_DIR, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { keepRunsLocal } from "@ocean/loop/loops/iteration-graph.js";
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

const checkpoints = async (root) =>
  JSON.parse(
    await readFile(
      path.join(root, SYSTEM_DIR, "loop-checkpoints.json"),
      "utf8",
    ),
  );

test("an iteration the process died in resumes at its step without re-running the agent", async () => {
  const ws = await workspace();
  try {
    await withRoot(ws.root, async () => {
      const loop = await startTaskLoop({
        taskId: "T-101",
        profile: "writer",
        prompt: "work",
        cwd: ws.repo,
        approved: true,
      });
      const crashed = crashInVerify(ws);
      assert.equal(crashed.status, 9, crashed.stderr);
      assert.equal(await readFile(ws.marker, "utf8"), "run\n");
      assert.equal((await listTaskLoops())[0].iterations, 0);
      assert.ok((await checkpoints(ws.root)).storage[loop.id]);

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
      assert.equal((await checkpoints(ws.root)).storage[loop.id], undefined);
    });
  } finally {
    await rm(ws.root, { recursive: true, force: true });
    await rm(ws.repo, { recursive: true, force: true });
  }
});

test("a loop stopped after a crash drops its interrupted iteration", async () => {
  const ws = await workspace();
  try {
    await withRoot(ws.root, async () => {
      const loop = await startTaskLoop({
        taskId: "T-101",
        profile: "writer",
        prompt: "work",
        cwd: ws.repo,
        approved: true,
      });
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
      assert.equal((await checkpoints(ws.root)).storage[loop.id], undefined);
    });
  } finally {
    await rm(ws.root, { recursive: true, force: true });
    await rm(ws.repo, { recursive: true, force: true });
  }
});

test("a step still failing after its retries is one failed attempt, and the next pass starts fresh", async () => {
  const ws = await workspace();
  try {
    await withRoot(ws.root, async () => {
      const loop = await startTaskLoop({
        taskId: "T-101",
        profile: "writer",
        prompt: "work",
        cwd: ws.repo,
        approved: true,
        intervalMs: 1_000,
        maxAttempts: 2,
      });
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
      assert.equal(verifies, 3, "verify is retried in place");
      const [after] = await listTaskLoops();
      assert.equal(after.status, "active");
      assert.equal(after.iterations, 1);
      assert.equal(after.failures, 1);
      assert.equal(after.lastError, "verifier unavailable");
      assert.equal((await checkpoints(ws.root)).storage[loop.id], undefined);
    });
  } finally {
    await rm(ws.root, { recursive: true, force: true });
    await rm(ws.repo, { recursive: true, force: true });
  }
});

test("loop runs never turn on LangSmith tracing", () => {
  const env = { LANGSMITH_TRACING: "true", LANGCHAIN_TRACING_V2: "true" };
  keepRunsLocal(env);
  assert.deepEqual(env, {
    LANGSMITH_TRACING: "false",
    LANGCHAIN_TRACING_V2: "false",
    LANGSMITH_TRACING_V2: "false",
    LANGCHAIN_TRACING: "false",
  });
});
