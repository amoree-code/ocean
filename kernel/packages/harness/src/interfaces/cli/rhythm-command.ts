import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, withFileLock } from "@ocean/core/shared/fs-utils.js";
import { localDate } from "@ocean/core/shared/local-date.js";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { openSessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";
import { prepareDay } from "@ocean/services/day/day.js";
import { hasBlock, noteFile } from "@ocean/services/day/note.js";
import {
  distillWeek,
  isoWeek,
  reviewMonth,
} from "@ocean/services/distill/distill.js";
import {
  archiveHarvested,
  harvestDay,
  pendingDays,
} from "@ocean/services/harvest/harvest.js";
import { readCallLedger } from "@ocean/services/infrastructure/mcp/call-ledger.js";
import { runUpkeepCommand } from "./upkeep-command.js";
import { weekFailures } from "./week-failures.js";

// `ocean rhythm [--yes]` (T-314): everything the day, week and month need, with no model, each
// at most once: today's morning note, every day not yet harvested (and today so far), the
// archive, last week's digest once the week is over, last month's review once the month is over,
// then the nightly upkeep and its morning digest once a day (T-322).
// The background service runs it at each session start; a run with nothing due is quick.

const stampFile = () => oceanPath(SYSTEM_DIR, "state", "rhythm.json");
type Stamp = { week?: string; month?: string };

const previousMonth = (date: string) => {
  const [year, month] = date.split("-").map(Number);
  return month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, "0")}`;
};

export async function runRhythmCommand(args: string[]): Promise<void> {
  await mkdir(path.dirname(stampFile()), { recursive: true });
  // One run at a time: a session start and the hourly service tick can land together.
  await withFileLock(stampFile(), () => rhythm(args));
  // Nightly upkeep (T-322) once a day, outside the rhythm lock: its jobs take minutes. A run that
  // finds another one holding the upkeep lock leaves it to that one.
  if (args.includes("--yes"))
    await runUpkeepCommand(["--yes", "--if-due"]).catch((error) => {
      if (!/still held/.test(String(error))) throw error;
    });
}

async function rhythm(args: string[]): Promise<void> {
  const apply = args.includes("--yes");
  const today = localDate();
  const stamp: Stamp = JSON.parse(
    await readFile(stampFile(), "utf8").catch(() => "{}"),
  );
  const done: Record<string, unknown> = {};
  // Morning: once a day, when today's note has no Today block yet.
  const note = await readFile(noteFile(today), "utf8").catch(() => "");
  if (!hasBlock(note, "day"))
    done.day = (
      await prepareDay({ date: today, apply, calls: readCallLedger })
    ).note;
  // The days not yet told, then today so far.
  const store = await openSessionStore();
  try {
    const sessions = store.list();
    const eventsOf = (id: string) => store.listEvents(id);
    const days = [...(await pendingDays(today)), today];
    const told = [];
    for (const date of days) {
      const result = await harvestDay({
        date,
        apply,
        store: { sessions, eventsOf },
      });
      if (result.note) told.push(date);
    }
    done.harvested = told;
  } finally {
    store.close();
  }
  done.archived = await archiveHarvested({ today, apply });
  // Last week, once it is over.
  const lastWeek = isoWeek(
    new Date(Date.parse(today) - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10),
  );
  if (stamp.week !== lastWeek.label) {
    done.week = await distillWeek({
      date: lastWeek.from,
      apply,
      failures: weekFailures,
    });
    if (apply) stamp.week = lastWeek.label;
  }
  // Last month, once it is over (the review itself is written once and never overwritten).
  const month = previousMonth(today);
  if (stamp.month !== month) {
    done.month = await reviewMonth({ month, apply });
    if (apply) stamp.month = month;
  }
  if (apply) {
    await atomicWrite(stampFile(), `${JSON.stringify(stamp, null, 2)}\n`);
  }
  console.log(JSON.stringify(done, null, 2));
  if (!apply) console.error("Dry run: pass --yes to write.");
}
