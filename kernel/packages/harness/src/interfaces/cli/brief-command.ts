import { localDate } from "@ocean/core/shared/local-date.js";
import { buildBrief } from "@ocean/services/brief/brief.js";

// `ocean brief [--weekly] [--dry-run] [--date YYYY-MM-DD]` (T-314): what moved in what the owner
// follows, written to 01-daily/briefs/.
export async function runBriefCommand(args: string[]): Promise<void> {
  const at = args.indexOf("--date");
  const date = at >= 0 ? args[at + 1] : localDate();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error(
      "Usage: ocean brief [--weekly] [--dry-run] [--date YYYY-MM-DD]",
    );
  const result = await buildBrief({
    date,
    weekly: args.includes("--weekly"),
    dryRun: args.includes("--dry-run"),
  });
  console.log(JSON.stringify(result, null, 2));
}
