import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listTaskLoops,
  startTaskLoop,
  stopTaskLoop,
} from "../dist/application/loops/task-loop.js";

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
      maxIterations: 3,
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
  const { runTaskLoopsOnce } = await import(
    "../dist/application/loops/task-loop.js"
  );
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
      "---\nid: T-101\ntitle: x\nstate: done\nproject: shop\n---\n\n## Next action\n\nx\n\n## Verification\n\n`pnpm test`\n\n## Log\n\n",
    );
    const loop = await startTaskLoop({
      taskId: "T-101",
      profile: "writer",
      prompt: "work",
      cwd: repo,
      approved: true,
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
