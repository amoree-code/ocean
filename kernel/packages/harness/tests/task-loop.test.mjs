import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listTaskLoops,
  startTaskLoop,
  stopTaskLoop,
} from "@ocean/loop/loops/task-loop.js";

// T-322 (C2): a loop declares its guard; its run cap is the iteration cap.
const GUARD = {
  verify: "true",
  maxRuns: 10,
  budgetTokens: 1_000_000,
  noProgressRuns: 3,
  escalate: "inbox",
};

test("task loop persists bounded state and stops explicitly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-loop-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    const loop = await startTaskLoop({
      taskId: "T-213",
      profile: "researcher",
      prompt: "Work one bounded action",
      cwd: root,
      approved: true,
      guard: { ...GUARD, maxRuns: 3 },
      intervalMs: 1_000,
      maxAttempts: 2,
    });
    assert.equal((await listTaskLoops()).length, 1);
    assert.equal(loop.maxIterations, 3);
    assert.equal((await stopTaskLoop(loop.id)).status, "stopped");
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a task loop remembers its project and works a task outside the workspace project", async () => {
  const { mkdir, readFile, writeFile } = await import("node:fs/promises");
  const { runTaskLoopsOnce } = await import("@ocean/loop/loops/task-loop.js");
  const { createAgentRuntime } = await import("../dist/composition/runtime.js");
  const { PROJECTS_DIR, SYSTEM_DIR } = await import(
    "@ocean/core/shared/paths.js"
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-loop-project-"));
  const repo = await mkdtemp(path.join(os.tmpdir(), "ocean-loop-repo-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
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
    const file = path.join(shop, "tasks", "T-101", "task.md");
    await writeFile(
      file,
      "---\nid: T-101\ntitle: x\nstate: done\nproject: shop\n---\n\n## Next action\n\nx\n\n## Verification\n\n```\npnpm test\n```\n\n## Log\n\n",
    );
    const loop = await startTaskLoop({
      taskId: "T-101",
      profile: "writer",
      prompt: "work",
      cwd: repo,
      approved: true,
      guard: GUARD,
    });
    assert.equal(loop.projectId, "shop");
    const runtime = createAgentRuntime({
      executeProvider: async () => ({ exitCode: 0, events: [], stderr: "" }),
    });
    const ran = await runTaskLoopsOnce(repo, runtime, {
      verifyRun: async () => ({ exitCode: 0 }),
    });
    assert.deepEqual(ran, [loop.id]);
    assert.equal((await listTaskLoops())[0].status, "completed");
    assert.match(await readFile(file, "utf8"), /iteration 1/);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a loop needs a well-formed task id, prefixed or legacy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-loop-ids-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    const input = {
      profile: "researcher",
      prompt: "x",
      cwd: root,
      approved: true,
      guard: GUARD,
    };
    assert.equal(
      (await startTaskLoop({ ...input, taskId: "OL-001" })).taskId,
      "OL-001",
    );
    await assert.rejects(
      startTaskLoop({ ...input, taskId: "ol-1" }),
      /valid task id/,
    );
    await assert.rejects(
      startTaskLoop({ ...input, taskId: "T1" }),
      /valid task id/,
    );
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a loop without a complete guard is refused; a tripped guard fails it and escalates (T-322)", async () => {
  const { mkdir, readdir, writeFile } = await import("node:fs/promises");
  const { runTaskLoopsOnce } = await import("@ocean/loop/loops/task-loop.js");
  const { createAgentRuntime } = await import("../dist/composition/runtime.js");
  const { PROJECTS_DIR, SYSTEM_DIR } = await import(
    "@ocean/core/shared/paths.js"
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-loop-guard-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    const input = {
      taskId: "T-102",
      profile: "writer",
      prompt: "work",
      cwd: root,
      approved: true,
    };
    await assert.rejects(startTaskLoop(input), /Refused: .*verify/);
    await assert.rejects(
      startTaskLoop({ ...input, guard: { ...GUARD, escalate: "email" } }),
      /escalate: human escalation/,
    );
    await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
    await writeFile(
      path.join(root, SYSTEM_DIR, "profiles", "writer.json"),
      JSON.stringify({
        name: "writer",
        provider: "claude",
        role: "writer",
        writePolicy: "workspace",
      }),
    );
    const dir = path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-102");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "task.md"),
      "---\nid: T-102\ntitle: x\nstate: active\nproject: ocean\n---\n\n## Log\n\n",
    );
    const loop = await startTaskLoop({
      ...input,
      guard: { ...GUARD, verify: "exit 1", noProgressRuns: 1 },
    });
    const runtime = createAgentRuntime({
      executeProvider: async () => ({ exitCode: 0, events: [], stderr: "" }),
    });
    await runTaskLoopsOnce(root, runtime, {
      verifyRun: async () => ({ exitCode: 0 }),
    });
    const [after] = await listTaskLoops();
    assert.equal(after.id, loop.id);
    assert.equal(after.status, "failed");
    assert.equal(
      after.lastError,
      "guard: no verified progress in 1 runs in a row",
    );
    assert.deepEqual(after.usage, { runs: 1, tokens: 0, noProgress: 1 });
    const notes = await readdir(path.join(root, "00-inbox", "escalations"));
    assert.equal(notes.length, 1);
    assert.match(notes[0], new RegExp(`-loop-${loop.id}\\.md$`));
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
