import { reindexBrain } from "../../application/brain/brain-reindex.js";
import {
  brainNeighbors,
  brainRead,
  brainSearch,
} from "../../application/brain/brain-service.js";
import {
  doctorMemoryIndexes,
  syncMemoryIndexes,
} from "../../application/memory/index-sync.js";
import {
  deleteProfileFact,
  readProfileFacts,
  writeProfileFact,
} from "../../application/memory/profile-facts.js";
import { defaultBrainIndexPort } from "../../composition/runtime.js";
import { createOllamaEmbedder } from "../../infrastructure/providers/ollama-embedder.js";

async function runReindex(args: string[]): Promise<void> {
  const noVectors = args.includes("--no-vectors");
  let embedder = null;
  if (!noVectors) {
    try {
      embedder = await createOllamaEmbedder();
    } catch (error) {
      console.error(
        `reindex refused: embedder unavailable (${error instanceof Error ? error.message : String(error)}). Pass --no-vectors to index without vectors.`,
      );
      process.exitCode = 1;
      return;
    }
  }
  const result = await reindexBrain({
    embedder,
    indexPort: defaultBrainIndexPort,
  });
  console.log(JSON.stringify(result, null, 2));
}

async function runSearch(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const query = args.filter((arg) => !arg.startsWith("--")).join(" ");
  if (!query) {
    console.error("Usage: ocean memory search <query> [--json]");
    process.exitCode = 1;
    return;
  }
  try {
    const result = await brainSearch({
      query,
      indexPort: defaultBrainIndexPort,
    });
    console.log(
      json ? JSON.stringify(result) : JSON.stringify(result, null, 2),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function runRead(args: string[]): Promise<void> {
  const idOrPath = args[0];
  if (!idOrPath) {
    console.error("Usage: ocean memory read <id|path>");
    process.exitCode = 1;
    return;
  }
  try {
    console.log(
      JSON.stringify(
        await brainRead({ idOrPath, indexPort: defaultBrainIndexPort }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function runNeighbors(args: string[]): Promise<void> {
  const idOrPath = args[0];
  const depthIndex = args.indexOf("--depth");
  const depth = depthIndex >= 0 ? Number(args[depthIndex + 1]) : 1;
  if (!idOrPath) {
    console.error("Usage: ocean memory neighbors <id|path> [--depth N]");
    process.exitCode = 1;
    return;
  }
  try {
    console.log(
      JSON.stringify(
        await brainNeighbors({
          idOrPath,
          depth: depth === 2 ? 2 : 1,
          indexPort: defaultBrainIndexPort,
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function runFacts(args: string[]): Promise<void> {
  const profile = args[0];
  if (!profile) {
    console.error("Usage: ocean memory facts <profile> [key] [value]");
    process.exitCode = 1;
    return;
  }
  try {
    if (args[1] === "delete" && args[2])
      console.log(
        JSON.stringify(
          { deleted: await deleteProfileFact(profile, args[2]) },
          null,
          2,
        ),
      );
    else if (args.length >= 3)
      console.log(
        JSON.stringify(
          await writeProfileFact(profile, args[1], args.slice(2).join(" ")),
          null,
          2,
        ),
      );
    else console.log(JSON.stringify(await readProfileFacts(profile), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function runMemoryCommand(
  action: string,
  args: string[],
): Promise<void> {
  if (action === "reindex") return runReindex(args);
  if (action === "search") return runSearch(args);
  if (action === "read") return runRead(args);
  if (action === "neighbors") return runNeighbors(args);
  if (action === "facts") return runFacts(args);
  if (action === "doctor") {
    const result = await doctorMemoryIndexes();
    if (!result.ok) {
      if (result.missing.length)
        console.error(
          `NOT READY: unindexed records: ${result.missing.join(", ")}`,
        );
      if (result.broken.length)
        console.error(
          `NOT READY: broken index links: ${result.broken.join(", ")}`,
        );
      process.exitCode = 1;
    } else
      console.log("PROVEN: memory and knowledge indexes are synchronized.");
    return;
  }
  if (action === "sync") {
    const result = await syncMemoryIndexes(args.includes("--apply"));
    console.log(
      JSON.stringify(
        { dryRun: !args.includes("--apply"), stores: result },
        null,
        2,
      ),
    );
    return;
  }
  console.error(
    "Usage: ocean memory doctor|sync [--apply]|facts <profile> [key] [value]|facts <profile> delete <key>|reindex [--no-vectors]|search <q> [--json]|read <id|path>|neighbors <id|path> [--depth N]",
  );
  process.exitCode = 1;
}
