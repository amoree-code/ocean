import { localDate } from "@ocean/core/shared/local-date.js";
import { distillWeek, reviewMonth } from "@ocean/services/distill/distill.js";
import { weekFailures } from "./week-failures.js";

const USAGE =
  "Usage: ocean distill --week [--date YYYY-MM-DD] [--yes] | --month [--month-of YYYY-MM] [--yes]";

// `ocean distill --week` (T-314): the week's session records and briefs into one digest, its
// decisions and lessons into candidates; a dry run until --yes.
export async function runDistillCommand(args: string[]): Promise<void> {
  if (args.includes("--month")) {
    // The month just ended by default: a review is written once the month is over.
    const at = args.indexOf("--month-of");
    const month = at >= 0 ? args[at + 1] : previousMonth(localDate());
    if (!month || !/^\d{4}-\d{2}$/.test(month)) throw new Error(USAGE);
    const result = await reviewMonth({ month, apply: args.includes("--yes") });
    console.log(JSON.stringify(result, null, 2));
    if (!args.includes("--yes")) console.error("Dry run: pass --yes to write.");
    return;
  }
  if (!args.includes("--week")) throw new Error(USAGE);
  const at = args.indexOf("--date");
  const date = at >= 0 ? args[at + 1] : localDate();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(USAGE);
  const result = await distillWeek({
    date,
    apply: args.includes("--yes"),
    failures: weekFailures,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!args.includes("--yes")) console.error("Dry run: pass --yes to write.");
}

export function previousMonth(date: string): string {
  const [year, month] = date.split("-").map(Number);
  return month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, "0")}`;
}
