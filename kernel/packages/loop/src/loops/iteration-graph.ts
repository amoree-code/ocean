import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  Annotation,
  END,
  MemorySaver,
  type RetryPolicy,
  START,
  StateGraph,
} from "@langchain/langgraph";
import type { TaskLoop } from "./task-loop-record.js";

// One loop iteration as a LangGraph graph: work → verify → record. Every step's result is
// checkpointed under the loop's id, so an iteration the process died in resumes at the step it
// was in — a finished agent session is not run again. The loop's own policy (budget, attempts,
// interval, stop) stays in the steps and in the caller; the graph only makes them durable.
export type IterationSteps = {
  // Runs the agent session and applies the budget and attempt policy to the record.
  work(loop: TaskLoop): Promise<{ loop: TaskLoop; next: "verify" | "end" }>;
  verify(loop: TaskLoop): Promise<TaskLoop>;
  record(loop: TaskLoop): Promise<TaskLoop>;
};

const IterationState = Annotation.Root({
  loop: Annotation<TaskLoop>(),
  next: Annotation<"verify" | "end">(),
  ran: Annotation<boolean>(),
});

// Only record is retried in place, and only on a filesystem error: it writes files and is safe
// to repeat. work (a provider run) and verify (the task's own checks, a test suite say) are
// never re-run here; the loop's interval and attempt budget decide when they run again. No
// jitter and no log line: retries must not write to stdout, which carries command JSON.
const recordRetry: RetryPolicy = {
  maxAttempts: 3,
  initialInterval: 200,
  jitter: false,
  logWarning: false,
  retryOn: (error) => typeof (error as { code?: unknown })?.code === "string",
};

export function iterationGraph(
  steps: IterationSteps,
  checkpointer: MemorySaver,
) {
  return new StateGraph(IterationState)
    .addNode("work", (state) => steps.work(state.loop))
    .addNode("verify", async (state) => ({
      loop: await steps.verify(state.loop),
    }))
    .addNode(
      "record",
      async (state) => ({ loop: await steps.record(state.loop), ran: true }),
      { retryPolicy: recordRetry },
    )
    .addEdge(START, "work")
    .addConditionalEdges(
      "work",
      (state) => (state.next === "verify" ? "verify" : END),
      ["verify", END],
    )
    .addEdge("verify", "record")
    .addEdge("record", END)
    .compile({ checkpointer });
}

// LangChain sends every run to LangSmith when one of these is "true", which a shell set up for
// another project may well have. It reads them only from process.env, with no per-run switch,
// so loop state (prompts, task ids, paths) stays on this machine by turning off just the ones
// that are on; processes the loop starts inherit that.
export function keepRunsLocal(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of [
    "LANGSMITH_TRACING_V2",
    "LANGCHAIN_TRACING_V2",
    "LANGSMITH_TRACING",
    "LANGCHAIN_TRACING",
  ])
    if (env[name] === "true") env[name] = "false";
}

type ThreadStorage = MemorySaver["storage"][string];
type ThreadWrites = MemorySaver["writes"][string];
type SavedThread = {
  threadId: string;
  storage: ThreadStorage;
  writes: Record<string, ThreadWrites>;
};

const bytesKey = "$bytes";
const safeThreadId = /^[A-Za-z0-9_-]+$/;

// MemorySaver keeps its maps prototype-free so no key can reach Object.prototype; JSON.parse
// does not, so rebuild them that way.
function prototypeFree(value: unknown, depth: number): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value as Record<string, unknown>))
    out[key] = depth > 0 ? prototypeFree(item, depth - 1) : item;
  return out;
}

// MemorySaver's checkpoints kept on disk, one file per thread (a loop), so a thread resumes after
// the process is gone and two processes working different loops never overwrite each other.
// The LangGraph version is pinned exactly because this relies on MemorySaver's typed `storage`
// and `writes` maps and its `[thread, namespace, checkpoint]` write keys.
export class FileCheckpointSaver extends MemorySaver {
  readonly #saving = new Map<string, Promise<void>>();

  private constructor(private readonly dir: string) {
    super();
  }

  static async open(dir: string): Promise<FileCheckpointSaver> {
    const saver = new FileCheckpointSaver(dir);
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const full = path.join(dir, file);
      try {
        const saved = JSON.parse(await readFile(full, "utf8"), (_key, value) =>
          value &&
          typeof value === "object" &&
          typeof value[bytesKey] === "string" &&
          Object.keys(value).length === 1
            ? new Uint8Array(Buffer.from(value[bytesKey], "base64"))
            : value,
        ) as SavedThread;
        if (!safeThreadId.test(saved.threadId))
          throw new Error("unsafe thread id");
        saver.storage[saved.threadId] = prototypeFree(
          saved.storage,
          1,
        ) as ThreadStorage;
        for (const [key, writes] of Object.entries(saved.writes))
          saver.writes[key] = prototypeFree(writes, 0) as ThreadWrites;
      } catch {
        // An unreadable thread is set aside rather than stopping every loop; the worst case is
        // that its iteration runs again from the start.
        await rename(full, `${full}.unreadable-${Date.now()}`).catch(
          () => undefined,
        );
      }
    }
    return saver;
  }

  override async put(
    ...args: Parameters<MemorySaver["put"]>
  ): ReturnType<MemorySaver["put"]> {
    const result = await super.put(...args);
    await this.#save(args[0].configurable?.thread_id);
    return result;
  }

  override async putWrites(
    ...args: Parameters<MemorySaver["putWrites"]>
  ): Promise<void> {
    await super.putWrites(...args);
    await this.#save(args[0].configurable?.thread_id);
  }

  override async deleteThread(threadId: string): Promise<void> {
    await super.deleteThread(threadId);
    await this.#save(threadId);
  }

  // One thread's saves run one after another, each writing what is current when it starts; a
  // failed save fails its own caller, not the ones after it.
  #save(threadId: unknown): Promise<void> {
    if (typeof threadId !== "string" || !safeThreadId.test(threadId))
      return Promise.reject(
        new Error(`Unsafe checkpoint thread id: ${String(threadId)}`),
      );
    const file = path.join(this.dir, `${threadId}.json`);
    const run = (this.#saving.get(threadId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const storage = this.storage[threadId];
        const writes = Object.fromEntries(
          Object.entries(this.writes).filter(
            ([key]) => (JSON.parse(key) as unknown[])[0] === threadId,
          ),
        );
        if (!storage && !Object.keys(writes).length) {
          await rm(file, { force: true });
          return;
        }
        const payload = JSON.stringify(
          { threadId, storage: storage ?? {}, writes } satisfies SavedThread,
          // `this[key]` is the value before toJSON (a Buffer would otherwise arrive as JSON).
          function (this: Record<string, unknown>, key, value) {
            const raw = this[key];
            return raw instanceof Uint8Array
              ? { [bytesKey]: Buffer.from(raw).toString("base64") }
              : value;
          },
        );
        await mkdir(this.dir, { recursive: true });
        const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temp, `${payload}\n`, { mode: 0o600 });
        await rename(temp, file);
      });
    this.#saving.set(threadId, run);
    return run;
  }
}
