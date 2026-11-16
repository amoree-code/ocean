import {
  decayInterests,
  interestFeedback,
  proposeDiscoveredInterests,
} from "@ocean/services/brief/interest-discovery.js";

const USAGE =
  "Usage: ocean interests discover [--yes] | decay [--weeks N] [--yes] | keep <name> | skip <name>";

// `ocean interests` (T-314): discover candidate interests from registered projects, decay the
// ones with no signal, and record keep/skip feedback on brief items.
export async function runInterestsCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  const apply = args.includes("--yes");
  let result: unknown;
  if (action === "discover")
    result = await proposeDiscoveredInterests({ apply });
  else if (action === "decay") {
    const at = args.indexOf("--weeks");
    const weeks = at >= 0 ? Number(args[at + 1]) : undefined;
    if (weeks !== undefined && !(weeks > 0)) throw new Error(USAGE);
    result = await decayInterests({ apply, weeks });
  } else if ((action === "keep" || action === "skip") && rest.length)
    result = await interestFeedback(rest.join(" "), action);
  else throw new Error(USAGE);
  console.log(JSON.stringify(result, null, 2));
  if ((action === "discover" || action === "decay") && !apply)
    console.error("Dry run: pass --yes to apply.");
}
