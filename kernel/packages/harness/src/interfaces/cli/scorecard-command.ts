import {
  brainIndexState,
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
import { listSchedules } from "../../application/scheduler/local-scheduler.js";

const USAGE = "Usage: ocean scorecard [--json] [--write]";

async function collect(): Promise<ScorecardInput> {
  const store = await openSessionStoreReadOnly();
  let sessions: ScorecardInput["sessions"];
  const tokens = { sessions: 0, reporting: 0, total: 0 };
  try {
    const all = store.list();
    sessions = all;
    tokens.sessions = all.length;
    for (const session of all) {
      const used = sessionTokens(store.listEvents(session.sessionId));
      if (used === null) continue;
      tokens.reporting += 1;
      tokens.total += used;
    }
  } finally {
    store.close();
  }
  const built = await ensureIndexBuilt();
  const index = await brainIndexState({ indexPort: brainIndexPort });
  return {
    clients: await clientFindings(),
    sessions,
    memoryAudit: await readAudit(),
    tasks: await readTaskFrontmatter(),
    search: { built, hasVectors: index.hasVectors, stale: index.stale },
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
