import { readFile } from "node:fs/promises";
import {
  type EvalCase,
  evaluateRecall,
} from "@ocean/brain/brain/brain-eval.js";
import {
  brainIndexPath,
  computeCorpusHash,
  reindexBrain,
} from "@ocean/brain/brain/brain-reindex.js";
import {
  brainNeighbors,
  brainRead,
  brainSearch,
} from "@ocean/brain/brain/brain-service.js";
import {
  doctorMemoryIndexes,
  syncMemoryIndexes,
} from "@ocean/brain/memory/index-sync.js";
import { memoryDigest } from "@ocean/brain/memory/memory-digest.js";
import {
  approveCandidate,
  listCandidates,
  rejectCandidate,
} from "@ocean/brain/memory/memory-review.js";
import {
  deleteMemoryRecord,
  memoryHistory,
  purgeMemoryCopies,
  restoreMemory,
} from "@ocean/brain/memory/memory-trash.js";
import {
  deleteProfileFact,
  readProfileFacts,
  writeProfileFact,
} from "@ocean/brain/memory/profile-facts.js";
import { isValidProjectId } from "@ocean/core/domain/context/project-id.js";
import { folderProject } from "@ocean/core/shared/project-resolution.js";
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

const searchUsage =
  "Usage: ocean memory search <query> [--project <id> | --all] [--json]";
const neighborsUsage =
  "Usage: ocean memory neighbors <id|path> [--depth N] [--project <id> | --all]";

// --project <id> / --all, shared by search and neighbors. Default: the cwd's project plus
// global records; --all is the explicit unscoped view. null means the flags are malformed.
function parseScopeFlags(
  args: string[],
): { all: boolean; project?: string; rest: string[] } | null {
  let all = false;
  let project: string | undefined;
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--all") all = true;
    else if (arg === "--project") {
      project = args[index + 1] ?? "";
      index += 1;
    } else rest.push(arg);
  }
  if (project !== undefined && (all || !isValidProjectId(project))) return null;
  return { all, project, rest };
}

async function scopeFrom(flags: {
  all: boolean;
  project?: string;
}): Promise<{ project: string | null } | undefined> {
  return flags.all
    ? undefined
    : { project: flags.project ?? (await folderProject(process.cwd())) };
}

async function runSearch(args: string[]): Promise<void> {
  const flags = parseScopeFlags(args);
  const json = args.includes("--json");
  const query = (flags?.rest ?? [])
    .filter((arg) => !arg.startsWith("--"))
    .join(" ");
  if (!flags || !query) {
    console.error(searchUsage);
    process.exitCode = 1;
    return;
  }
  try {
    const result = await brainSearch({
      query,
      scope: await scopeFrom(flags),
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
  const flags = parseScopeFlags(args);
  const rest = flags?.rest ?? [];
  const depthIndex = rest.indexOf("--depth");
  const depth = depthIndex >= 0 ? Number(rest[depthIndex + 1]) : 1;
  const idOrPath = rest[0];
  if (!flags || !idOrPath || idOrPath.startsWith("--")) {
    console.error(neighborsUsage);
    process.exitCode = 1;
    return;
  }
  try {
    console.log(
      JSON.stringify(
        await brainNeighbors({
          idOrPath,
          depth: depth === 2 ? 2 : 1,
          scope: await scopeFrom(flags),
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

// The value after a flag, or undefined.
function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

// Soft delete, history, restore and purge of memory records (T-296). Purge is CLI-only and
// lists what it would drop until --yes confirms it.
async function runRecordCommand(
  action: "history" | "restore" | "delete" | "purge",
  args: string[],
): Promise<void> {
  const positional = args.filter(
    (arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"),
  );
  let result: unknown;
  if (action === "history") {
    const limit = Number(flagValue(args, "--limit") ?? 20);
    result = await memoryHistory({ path: positional[0], limit });
  } else if (action === "restore") {
    if (!positional[0])
      throw new Error(
        "Usage: ocean memory restore <audit-id> [--hash <sha256>]",
      );
    result = await restoreMemory({
      id: positional[0],
      expectedHash: flagValue(args, "--hash"),
      source: "cli",
    });
  } else if (action === "delete") {
    const hash = flagValue(args, "--hash");
    if (!positional[0] || !hash)
      throw new Error("Usage: ocean memory delete <path> --hash <sha256>");
    result = await deleteMemoryRecord({
      path: positional[0],
      expectedHash: hash,
      source: "cli",
    });
  } else {
    const days = flagValue(args, "--days");
    result = await purgeMemoryCopies({
      apply: args.includes("--yes"),
      days: days === undefined ? undefined : Number(days),
    });
    if (!args.includes("--yes"))
      console.error("Dry run: pass --yes to remove these copies for good.");
  }
  console.log(JSON.stringify(result, null, 2));
}

// Candidate review (T-296 P5): list, approve into a record, or reject. Edit = edit the candidate
// file, then approve it.
async function runReview(args: string[]): Promise<void> {
  const [verb = "list", id] = args;
  if (verb === "list") {
    const candidates = await listCandidates();
    if (args.includes("--json")) {
      console.log(JSON.stringify(candidates, null, 2));
      return;
    }
    if (!candidates.length) console.log("No memory candidates to review.");
    for (const item of candidates)
      console.log(
        `${item.id}  ${item.origin.padEnd(8)} ${item.target || "(no target)"}  ${item.file}${item.reason ? ` — ${item.reason}` : ""}`,
      );
    return;
  }
  if ((verb === "approve" || verb === "reject") && id) {
    const result =
      verb === "approve"
        ? await approveCandidate({ id, to: flagValue(args, "--to") })
        : await rejectCandidate(id);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.error(
    "Usage: ocean memory review [list] [--json] | approve <id> [--to <record path>] | reject <id>",
  );
  process.exitCode = 1;
}

// Recall@k over a JSON list of {question, expect, project?}; fails below --min.
async function runEval(args: string[]): Promise<void> {
  const file = args.find(
    (arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"),
  );
  if (!file) {
    console.error(
      "Usage: ocean memory eval <questions.json> [--k N] [--min 0.9] [--vectors]",
    );
    process.exitCode = 1;
    return;
  }
  const cases = JSON.parse(await readFile(file, "utf8")) as EvalCase[];
  const result = await evaluateRecall(cases, {
    indexPort: defaultBrainIndexPort,
    embedder: args.includes("--vectors") ? await createOllamaEmbedder() : null,
    k: Number(flagValue(args, "--k") ?? 5),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.recall < Number(flagValue(args, "--min") ?? 0.9))
    process.exitCode = 1;
}

async function indexIsStale(): Promise<boolean | null> {
  try {
    const reader = defaultBrainIndexPort.openIndexReadOnly(brainIndexPath());
    try {
      return reader.meta.corpusHash !== (await computeCorpusHash());
    } finally {
      reader.close();
    }
  } catch {
    return null;
  }
}

export async function runMemoryCommand(
  action: string,
  args: string[],
): Promise<void> {
  if (
    action === "history" ||
    action === "restore" ||
    action === "delete" ||
    action === "purge"
  )
    return runRecordCommand(action, args);
  if (action === "reindex") return runReindex(args);
  if (action === "review") return runReview(args);
  if (action === "eval") return runEval(args);
  if (action === "digest") {
    const lines = await memoryDigest({ stale: await indexIsStale() });
    console.log(lines.length ? lines.join("\n") : "memory: nothing to review");
    return;
  }
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
    "Usage: ocean memory doctor|sync [--apply]|review [list|approve <id> [--to <path>]|reject <id>]|eval <questions.json> [--k N] [--min R]|digest|history [path] [--limit N]|restore <id> [--hash <sha256>]|delete <path> --hash <sha256>|purge [--days N] [--yes]|facts <profile> [key] [value]|facts <profile> delete <key>|reindex [--no-vectors]|search <q> [--project <id>|--all] [--json]|read <id|path>|neighbors <id|path> [--depth N] [--project <id>|--all]",
  );
  process.exitCode = 1;
}
