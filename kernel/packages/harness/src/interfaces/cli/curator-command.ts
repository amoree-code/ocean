import { localDate } from "@ocean/core/shared/local-date.js";
import { curate, reviewCurated } from "@ocean/services/curator/curator.js";

const USAGE = "Usage: ocean curator [--yes] | review <lesson:id|skill:name>";

// `ocean curator [--yes] | review <key>` (T-322): mark lessons and skills stale after 30 days
// unused (or 90 unreviewed), archive after 90; `review` undoes a mark and stamps last_reviewed.
export async function runCuratorCommand(args: string[]): Promise<void> {
  if (args[0] === "review") {
    if (!args[1]) throw new Error(USAGE);
    console.log(
      JSON.stringify(await reviewCurated(args[1], localDate()), null, 2),
    );
    return;
  }
  if (args.some((arg) => arg !== "--yes")) throw new Error(USAGE);
  const apply = args.includes("--yes");
  const actions = await curate({ today: localDate(), apply });
  console.log(JSON.stringify({ actions }, null, 2));
  if (!apply) console.error("Dry run: pass --yes to apply.");
}
