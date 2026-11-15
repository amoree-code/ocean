import { localDate } from "@ocean/core/shared/local-date.js";
import {
  EXPRESS_KINDS,
  type ExpressKind,
  writeDraft,
} from "@ocean/services/express/express.js";

const USAGE = `Usage: ocean express ${EXPRESS_KINDS.join("|")} [--dry-run]`;

// `ocean express <kind>` (T-314): a draft from the owner's milestones into 00-inbox/drafts/.
export async function runExpressCommand(args: string[]): Promise<void> {
  const [kind] = args;
  if (!EXPRESS_KINDS.includes(kind as ExpressKind)) throw new Error(USAGE);
  const result = await writeDraft({
    kind: kind as ExpressKind,
    date: localDate(),
    dryRun: args.includes("--dry-run"),
  });
  if (!result.milestones)
    console.error(
      "No milestones yet: add 02-personal/milestones/<name>.md (type: milestone).",
    );
  console.log(result.file ?? result.text);
}
