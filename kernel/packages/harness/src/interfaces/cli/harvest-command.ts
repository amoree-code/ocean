import { localDate } from "@ocean/core/shared/local-date.js";
import { openSessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";
import {
  archiveHarvested,
  harvestDay,
  pendingDays,
  undoDay,
} from "@ocean/services/harvest/harvest.js";

const USAGE =
  "Usage: ocean harvest [--date YYYY-MM-DD | --pending] [--yes] | archive [--days N] [--yes] | undo <YYYY-MM-DD>";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// `ocean harvest` (T-316): a day's sessions from every AI client into that day's summary, their
// decisions, fixes and lessons into 05-knowledge on their own (undo per day), then archiving after
// 30 days. A dry run until --yes. The service runs `--pending --yes` once a day.
export async function runHarvestCommand(args: string[]): Promise<void> {
  const apply = args.includes("--yes");
  const [action] = args;
  if (action === "undo") {
    const date = args[1];
    if (!date || !DATE.test(date)) throw new Error(USAGE);
    console.log(JSON.stringify(await undoDay(date), null, 2));
    return;
  }
  if (action === "archive") {
    const at = args.indexOf("--days");
    const days = at >= 0 ? Number(args[at + 1]) : 30;
    if (!(days > 0)) throw new Error(USAGE);
    const result = await archiveHarvested({ today: localDate(), days, apply });
    console.log(JSON.stringify(result, null, 2));
    if (!apply) console.error("Dry run: pass --yes to move them.");
    return;
  }
  const at = args.indexOf("--date");
  const dates = args.includes("--pending")
    ? await pendingDays(localDate())
    : [at >= 0 ? args[at + 1] : localDate()];
  if (dates.some((date) => !date || !DATE.test(date))) throw new Error(USAGE);
  const store = await openSessionStore();
  try {
    const sessions = store.list();
    const results = [];
    for (const date of dates)
      results.push(
        await harvestDay({
          date,
          apply,
          store: { sessions, eventsOf: (id) => store.listEvents(id) },
        }),
      );
    // The daily run also archives what has been harvested for 30 days.
    const archived = args.includes("--pending")
      ? await archiveHarvested({ today: localDate(), apply })
      : null;
    console.log(JSON.stringify({ days: results, archived }, null, 2));
    if (!apply) console.error("Dry run: pass --yes to write.");
  } finally {
    store.close();
  }
}
