import { localDate } from "@ocean/core/shared/local-date.js";
import { distillWeek } from "@ocean/services/distill/distill.js";

const USAGE = "Usage: ocean distill --week [--date YYYY-MM-DD] [--yes]";

// `ocean distill --week` (T-314): the week's session records and briefs into one digest, its
// decisions and lessons into candidates; a dry run until --yes.
export async function runDistillCommand(args: string[]): Promise<void> {
  if (!args.includes("--week")) throw new Error(USAGE);
  const at = args.indexOf("--date");
  const date = at >= 0 ? args[at + 1] : localDate();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(USAGE);
  const result = await distillWeek({ date, apply: args.includes("--yes") });
  console.log(JSON.stringify(result, null, 2));
  if (!args.includes("--yes")) console.error("Dry run: pass --yes to write.");
}
