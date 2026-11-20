import { localDate } from "@ocean/core/shared/local-date.js";
import {
  runNightlyUpkeep,
  upkeepDoneToday,
  upkeepJobs,
} from "../../application/upkeep/nightly-upkeep.js";

// `ocean upkeep [--yes] [--if-due]` (T-322): the nightly jobs and the morning digest. `ocean
// rhythm` runs it with --if-due, so it happens at most once a day; by hand it always runs. A dry
// run lists tonight's jobs.
export async function runUpkeepCommand(args: string[]): Promise<void> {
  const unknown = args.filter((arg) => !["--yes", "--if-due"].includes(arg));
  if (unknown.length) throw new Error("Usage: ocean upkeep [--yes] [--if-due]");
  const today = localDate();
  const ifDue = args.includes("--if-due");
  if (ifDue && (await upkeepDoneToday(today))) {
    console.log(JSON.stringify({ upkeep: "done today" }));
    return;
  }
  if (!args.includes("--yes")) {
    const jobs = await upkeepJobs(today);
    console.log(
      JSON.stringify(
        { jobs: jobs.map((job) => `ocean ${job.args.join(" ")}`) },
        null,
        2,
      ),
    );
    console.error("Dry run: pass --yes to run them and write the digest.");
    return;
  }
  const ran = await runNightlyUpkeep({ today, ifDue });
  console.log(JSON.stringify(ran ?? { upkeep: "done today" }, null, 2));
}
