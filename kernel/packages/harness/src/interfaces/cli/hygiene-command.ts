import { localDate } from "@ocean/core/shared/local-date.js";
import {
  checkDrift,
  readHygieneHistory,
  renderHygieneReport,
  runHygiene,
  writeHygieneReport,
} from "@ocean/services/hygiene/hygiene.js";
import { claimChecker } from "../../application/upkeep/claim-checkers.js";

// `ocean memory hygiene [--yes]` and `ocean memory drift [--yes]` (T-322): argument parsing and
// output around services/hygiene and the checkers in application/upkeep.

export async function runHygieneCommand(args: string[]): Promise<void> {
  if (args.some((arg) => arg !== "--yes"))
    throw new Error("Usage: ocean memory hygiene [--yes]");
  const apply = args.includes("--yes");
  const { counts, records } = await runHygiene({
    today: localDate(),
    apply,
    check: claimChecker,
  });
  const drifted = records.filter((record) => record.verdict === "drifted");
  let report: string | null = null;
  if (apply)
    report = await writeHygieneReport(
      counts.month,
      renderHygieneReport(counts, records, await readHygieneHistory()),
    );
  console.log(JSON.stringify({ counts, drifted, report }, null, 2));
  if (!apply)
    console.error("Dry run: pass --yes to stamp records and write the report.");
}

export async function runDriftCommand(args: string[]): Promise<void> {
  if (args.some((arg) => arg !== "--yes"))
    throw new Error("Usage: ocean memory drift [--yes]");
  const result = await checkDrift({ apply: args.includes("--yes") });
  console.log(JSON.stringify(result, null, 2));
  if (!args.includes("--yes"))
    console.error("Dry run: pass --yes to save the snapshot and the result.");
}
