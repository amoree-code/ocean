import {
  brainSearch,
  ensureIndexBuilt,
} from "@ocean/brain/brain/brain-service.js";
import { brainIndexPort } from "@ocean/brain/infrastructure/brain/brain-index.js";
import { readAudit } from "@ocean/brain/memory/memory-audit.js";
import { localDate } from "@ocean/core/shared/local-date.js";
import { openSessionStoreReadOnly } from "@ocean/loop/infrastructure/persistence/session-store.js";
import {
  readLessonFrontmatter,
  readTaskFrontmatter,
  renderTable,
  type ScorecardInput,
  scorecardRows,
  sessionTokens,
  writeScorecard,
} from "@ocean/services/scorecard/scorecard.js";
import { clientFindings } from "../../application/clients/clients.js";
import { CLIENT_ADAPTERS } from "../../application/clients/registry.js";
import { listSchedules } from "../../application/scheduler/local-scheduler.js";
import { createOllamaEmbedder } from "../../infrastructure/providers/ollama-embedder.js";

// Every name a client can write under: its id, the MCP clientInfo names it sends, and Claude's
// web chat as `ocean pull` imports it.
const CLIENT_NAMES = new Set([
  ...CLIENT_ADAPTERS.flatMap((adapter) => [
    adapter.id,
    ...(adapter.mcpClients ?? []).map((client) => client.name),
  ]),
  "claude.ai",
]);

const USAGE = "Usage: ocean scorecard [--json] [--write]";

// One search the way the MCP server runs brain_search: with the local embedder when it answers.
async function probeSearch(): Promise<ScorecardInput["search"]> {
  const result = await brainSearch({
    query: "ocean",
    limit: 1,
    indexPort: brainIndexPort,
    embedder: await createOllamaEmbedder().catch(() => null),
  });
  return {
    built: true,
    mode: result.mode,
    stale: result.stale,
    vector: result.vector,
  };
}

async function collect(): Promise<ScorecardInput> {
  const store = await openSessionStoreReadOnly();
  let sessions: ScorecardInput["sessions"];
  const providers = new Map<string, string>();
  const tokens = { sessions: 0, reporting: 0, total: 0 };
  try {
    const all = store.list();
    sessions = all;
    tokens.sessions = all.length;
    for (const session of all) {
      providers.set(session.sessionId, session.provider);
      const used = sessionTokens(store.listEvents(session.sessionId));
      if (used === null) continue;
      tokens.reporting += 1;
      tokens.total += used;
    }
  } finally {
    store.close();
  }
  const search: ScorecardInput["search"] = (await ensureIndexBuilt())
    ? await probeSearch()
    : { built: false };
  return {
    clients: await clientFindings(),
    sessions,
    memoryAudit: await readAudit(),
    writers: {
      clients: CLIENT_NAMES,
      sessionProvider: (id) => providers.get(id) ?? null,
    },
    tasks: await readTaskFrontmatter(),
    search,
    searchEval: null,
    schedules: await listSchedules(),
    lessons: await readLessonFrontmatter(),
    tokens,
  };
}

// `ocean scorecard [--json] [--write]` (T-318): Ocean's health numbers from real data; --write
// also saves 01-daily/scorecard/YYYY-MM-DD.md.
export async function runScorecardCommand(args: string[]): Promise<void> {
  const unknown = args.filter((arg) => !["--json", "--write"].includes(arg));
  if (unknown.length) throw new Error(USAGE);
  const rows = scorecardRows(await collect());
  console.log(
    args.includes("--json")
      ? JSON.stringify({ date: localDate(), rows }, null, 2)
      : renderTable(rows),
  );
  if (args.includes("--write"))
    console.error(`Saved ${await writeScorecard(rows, localDate())}`);
}
