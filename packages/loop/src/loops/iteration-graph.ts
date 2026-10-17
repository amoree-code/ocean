import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

// verify and record only read the task and write files; a transient failure there is retried in
// place before it counts against the loop. work is never retried here: a provider run is costly
// and the loop's interval and attempt budget decide when it runs again.
const fileStepRetry: RetryPolicy = { maxAttempts: 3, initialInterval: 200 };

export function iterationGraph(
  steps: IterationSteps,
  checkpointer: MemorySaver,
) {
  return new StateGraph(IterationState)
    .addNode("work", (state) => steps.work(state.loop))
    .addNode(
      "verify",
      async (state) => ({ loop: await steps.verify(state.loop) }),
      { retryPolicy: fileStepRetry },
    )
    .addNode(
      "record",
      async (state) => ({ loop: await steps.record(state.loop), ran: true }),
      { retryPolicy: fileStepRetry },
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

// LangChain sends every run to LangSmith when one of these is "true" in the environment, which a
// shell set up for another project may well have. Loop state (prompts, task ids, paths) stays
// on this machine.
export function keepRunsLocal(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of [
    "LANGSMITH_TRACING_V2",
    "LANGCHAIN_TRACING_V2",
    "LANGSMITH_TRACING",
    "LANGCHAIN_TRACING",
  ])
    env[name] = "false";
}

type Saved = { storage: MemorySaver["storage"]; writes: MemorySaver["writes"] };

const bytesKey = "$bytes";

// MemorySaver's checkpoints, kept in a file so a thread can resume after the process is gone.
// Loaded once, rewritten atomically after every write; the LangGraph version is pinned exactly
// because this relies on MemorySaver's `storage` and `writes` layout.
export class FileCheckpointSaver extends MemorySaver {
  #saving: Promise<void> = Promise.resolve();

  private constructor(private readonly file: string) {
    super();
  }

  static async open(file: string): Promise<FileCheckpointSaver> {
    const saver = new FileCheckpointSaver(file);
    let source: string | undefined;
    try {
      source = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (source !== undefined) {
      const saved = JSON.parse(source, (_key, value) =>
        value &&
        typeof value === "object" &&
        typeof value[bytesKey] === "string" &&
        Object.keys(value).length === 1
          ? new Uint8Array(Buffer.from(value[bytesKey], "base64"))
          : value,
      ) as Saved;
      saver.storage = saved.storage;
      saver.writes = saved.writes;
    }
    return saver;
  }

  override async put(
    ...args: Parameters<MemorySaver["put"]>
  ): ReturnType<MemorySaver["put"]> {
    const result = await super.put(...args);
    await this.#save();
    return result;
  }

  override async putWrites(
    ...args: Parameters<MemorySaver["putWrites"]>
  ): Promise<void> {
    await super.putWrites(...args);
    await this.#save();
  }

  override async deleteThread(threadId: string): Promise<void> {
    await super.deleteThread(threadId);
    await this.#save();
  }

  // Saves run one after another, each writing the state current when it starts; a failed save
  // fails its own caller, not the ones after it.
  #save(): Promise<void> {
    const run = this.#saving
      .catch(() => undefined)
      .then(async () => {
        const payload = JSON.stringify(
          { storage: this.storage, writes: this.writes } satisfies Saved,
          // `this[key]` is the value before toJSON (a Buffer would otherwise arrive as JSON).
          function (this: Record<string, unknown>, key, value) {
            const raw = this[key];
            return raw instanceof Uint8Array
              ? { [bytesKey]: Buffer.from(raw).toString("base64") }
              : value;
          },
        );
        await mkdir(path.dirname(this.file), { recursive: true });
        const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temp, `${payload}\n`, { mode: 0o600 });
        await rename(temp, this.file);
      });
    this.#saving = run;
    return run;
  }
}
