import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRuntimeDeps } from "@ocean/core/domain/ports/runtime-ports.js";
import { TASK_ID } from "@ocean/core/domain/tasks/task-id.js";
import {
  oceanPath,
  PROJECTS_DIR,
  projectFolder,
  resolveWithin,
  SYSTEM_DIR,
} from "@ocean/core/shared/paths.js";
import { folderProject } from "@ocean/core/shared/project-resolution.js";
import {
  resolveTaskReference,
  type TaskLocation,
} from "@ocean/core/shared/task-reference.js";
import { runAgent } from "../runs/run-agent.js";
import { checkpointTask } from "../tasks/checkpoint-task.js";
import { type CommandRunner, verifyTask } from "../tasks/verify-task.js";
import type { IterationSteps } from "./iteration-graph.js";
import type { TaskLoop } from "./task-loop-record.js";

export type { TaskLoop } from "./task-loop-record.js";

const loopsFile = () => oceanPath(SYSTEM_DIR, "loops.json");
const checkpointsDir = () => oceanPath(SYSTEM_DIR, "loop-checkpoints");

export async function listTaskLoops(): Promise<TaskLoop[]> {
  try {
    return JSON.parse(await readFile(loopsFile(), "utf8")) as TaskLoop[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function startTaskLoop(input: {
  taskId: string;
  profile: string;
  prompt: string;
  cwd: string;
  approved: boolean;
  maxIterations?: number;
  intervalMs?: number;
  maxAttempts?: number;
}): Promise<TaskLoop> {
  if (!input.approved)
    throw new Error("Loop start requires explicit approval.");
  if (!input.taskId || !TASK_ID.test(input.taskId))
    throw new Error("Loop requires a valid task id.");
  const loop: TaskLoop = {
    id: `loop-${randomUUID()}`,
    taskId: input.taskId,
    projectId: await folderProject(input.cwd),
    profile: input.profile,
    prompt: input.prompt.trim(),
    cwd: input.cwd,
    status: "active",
    approved: true,
    maxIterations: bounded(input.maxIterations ?? 10, 1, 100),
    intervalMs: bounded(input.intervalMs ?? 60_000, 1_000, 86_400_000),
    maxAttempts: bounded(input.maxAttempts ?? 2, 1, 5),
    iterations: 0,
    failures: 0,
    nextRunAt: new Date().toISOString(),
    lastSessionId: null,
    lastError: null,
    checkpoint:
      "Loop created; inspect the task and choose the first bounded action.",
    resultPath: null,
  };
  await saveLoops([...(await listTaskLoops()), loop]);
  return loop;
}

export async function stopTaskLoop(id: string): Promise<TaskLoop> {
  const loops = await listTaskLoops();
  const loop = loops.find((item) => item.id === id);
  if (!loop) throw new Error(`Loop not found: ${id}`);
  loop.status = "stopped";
  await saveLoops(loops);
  return loop;
}

export async function runTaskLoopsOnce(
  cwd: string,
  runtime: AgentRuntimeDeps,
  options: { verifyRun?: CommandRunner } = {},
): Promise<string[]> {
  // LangGraph loads only when loops actually run, not on every `ocean` command.
  const { FileCheckpointSaver, iterationGraph, keepRunsLocal } = await import(
    "./iteration-graph.js"
  );
  keepRunsLocal();
  const checkpointer = await FileCheckpointSaver.open(checkpointsDir());
  const graph = iterationGraph(
    iterationSteps(cwd, runtime, options),
    checkpointer,
  );
  const loops = await listTaskLoops();
  const ran: string[] = [];
  for (const loop of loops) {
    const config = { configurable: { thread_id: loop.id } };
    try {
      const saved = await graph.getState(config);
      const reached = saved.values.loop as TaskLoop | undefined;
      if (reached && ["stopped", "completed", "failed"].includes(loop.status)) {
        // Stopped (or finished) since the process died: its iteration is dropped, not resumed.
        await checkpointer.deleteThread(loop.id);
        continue;
      }
      if (reached && saved.next.length === 0) {
        // The iteration finished but its result never reached loops.json: take it, don't redo it.
        Object.assign(loop, reached);
        await saveLoops(loops);
        await checkpointer.deleteThread(loop.id);
        continue;
      }
      // An iteration the process died in resumes at its step; a paused loop keeps it for later.
      const interrupted = saved.next.length > 0;
      if (loop.status !== "active") continue;
      if (!interrupted && Date.parse(loop.nextRunAt) > Date.now()) continue;
      try {
        // "sync": a step's checkpoint is on disk before the next step starts, so a crash in
        // verify never re-runs the agent session.
        const result = await graph.invoke(
          interrupted ? null : { loop: { ...loop }, ran: false },
          { ...config, durability: "sync" },
        );
        Object.assign(loop, result.loop);
        if (result.ran) ran.push(loop.id);
      } catch (error) {
        // A step that fails (record: after its retries) is one failed attempt of the loop.
        const failed = (await graph.getState(config)).values.loop;
        if (failed) Object.assign(loop, failed);
        recordFailure(loop, error);
      }
      // The record first, then the checkpoint: a crash between the two leaves a finished
      // thread, which the next pass takes instead of running again.
      await saveLoops(loops);
      await checkpointer.deleteThread(loop.id);
    } catch (error) {
      // Checkpoint storage failing for one loop is that loop's failed attempt, not the pass's.
      recordFailure(loop, error);
    }
  }
  await saveLoops(loops);
  return ran;
}

function recordFailure(loop: TaskLoop, error: unknown): void {
  loop.failures += 1;
  loop.lastError = error instanceof Error ? error.message : String(error);
  loop.nextRunAt = new Date(Date.now() + loop.intervalMs).toISOString();
  if (loop.failures >= loop.maxAttempts) loop.status = "failed";
}

// The loop's policy, step by step. Each step takes the record as the graph checkpointed it and
// returns the next one; none of them mutates its input, so a resumed step starts clean.
function iterationSteps(
  cwd: string,
  runtime: AgentRuntimeDeps,
  options: { verifyRun?: CommandRunner },
): IterationSteps {
  return {
    async work(current) {
      const loop = { ...current };
      if (loop.iterations >= loop.maxIterations) {
        loop.status = "failed";
        loop.lastError = "iteration budget exhausted";
        return { loop, next: "end" };
      }
      const sessionId = randomUUID();
      loop.iterations += 1;
      loop.lastSessionId = sessionId;
      try {
        const session = await runAgent(
          {
            sessionId,
            profileName: loop.profile,
            prompt: `${loop.prompt}\n\nLoop checkpoint: ${loop.checkpoint}\nWork only on task ${loop.taskId}. Complete one bounded action, verify it, and record the next checkpoint.`,
            cwd: loop.cwd || cwd,
            taskId: loop.taskId,
            runContract: {
              runId: loop.id,
              sessionId,
              profile: loop.profile,
              workingDirectory: loop.cwd || cwd,
              allowedTools: [],
              deniedTools: [],
              stopConditions: [
                "task complete",
                "missing input",
                "approval required",
                "verification failure",
                "budget exhausted",
              ],
              approval: { required: true, approved: loop.approved },
              budget: {
                timeoutMs: loop.intervalMs,
                maxAttempts: loop.maxAttempts,
                maxOutputBytes: 1_000_000,
              },
            },
          },
          runtime,
        );
        if (session.status !== "completed")
          throw new Error(`session ${session.status}`);
      } catch (error) {
        recordFailure(loop, error);
        return { loop, next: "end" };
      }
      loop.checkpoint = `Iteration ${loop.iterations} completed; inspect task ${loop.taskId} before continuing.`;
      loop.lastError = null;
      loop.nextRunAt = new Date(Date.now() + loop.intervalMs).toISOString();
      return { loop, next: "verify" };
    },
    // A task is only complete when it claims done AND an independent verifier agrees. A
    // self-reported `state: done` whose checks fail keeps the loop active and records why.
    async verify(current) {
      const loop = { ...current };
      const task = await loopTask(loop, cwd);
      if (await taskClaimsDone(task.file)) {
        const outcome = await verifyTask(task.id, tasksRootOf(task), {
          cwd: loop.cwd || cwd,
          run: options.verifyRun,
        });
        if (outcome.passed) loop.status = "completed";
        else loop.lastError = `not complete: ${outcome.reason}`;
      }
      return loop;
    },
    // Durable per-step checkpoint: survives a cold restart because it is written into the task
    // file, not just held in loops.json. The result file (an idempotent overwrite) goes first
    // and the task note (an append that never throws) last, so a retried record adds no
    // duplicate note.
    async record(current) {
      const loop = { ...current };
      const sessionId = loop.lastSessionId;
      if (!sessionId) throw new Error("record step reached without a session");
      const task = await loopTask(loop, cwd);
      loop.resultPath = await persistWorkerResult(loop, sessionId, "completed");
      await recordStepCheckpoint(loop, task, tasksRootOf(task), "completed");
      return loop;
    },
  };
}

// The loop's task, found where it lives now (renumbered or archived tasks included).
function loopTask(loop: TaskLoop, cwd: string): Promise<TaskLocation> {
  return resolveTaskReference(loop.taskId, {
    projectId: loop.projectId ?? undefined,
    cwd: loop.projectId ? undefined : loop.cwd || cwd,
  });
}

const tasksRootOf = (task: TaskLocation): string =>
  oceanPath(PROJECTS_DIR, projectFolder(task.projectId), "tasks");

async function recordStepCheckpoint(
  loop: TaskLoop,
  task: TaskLocation,
  root: string,
  status: string,
): Promise<void> {
  try {
    await checkpointTask(task.id, root, {
      note: `loop ${loop.id} iteration ${loop.iterations}: session ${status}; ${loop.lastError ?? "verified progress"}`,
    });
  } catch {
    // The task file may live under a non-default project; a missing file must
    // not crash the loop. Loop-level state in loops.json still persists.
  }
}

async function persistWorkerResult(
  loop: TaskLoop,
  sessionId: string,
  status: string,
): Promise<string> {
  const payload = JSON.stringify(
    {
      loopId: loop.id,
      taskId: loop.taskId,
      iteration: loop.iterations,
      sessionId,
      status,
      checkpoint: loop.checkpoint,
      lastError: loop.lastError,
      recordedAt: new Date().toISOString(),
    },
    null,
    2,
  );
  const dir = oceanPath(SYSTEM_DIR, "runs");
  await mkdir(dir, { recursive: true });
  const target = resolveWithin(dir, `${sessionId}.json`);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${payload}\n`, { mode: 0o600 });
  await rename(temp, target);
  return target;
}

export async function runTaskLoopWorker(
  cwd: string,
  runtime: AgentRuntimeDeps,
  options: { signal?: AbortSignal; pollMs?: number } = {},
): Promise<void> {
  const pollMs = options.pollMs ?? 30_000;
  while (!options.signal?.aborted) {
    await runTaskLoopsOnce(cwd, runtime);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      options.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

async function taskClaimsDone(file: string): Promise<boolean> {
  const source = await readFile(file, "utf8");
  return /^state:\s*done\s*$/m.test(source);
}

async function saveLoops(loops: TaskLoop[]): Promise<void> {
  const target = loopsFile();
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(loops, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, target);
}

function bounded(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Value must be an integer between ${min} and ${max}.`);
  return value;
}
