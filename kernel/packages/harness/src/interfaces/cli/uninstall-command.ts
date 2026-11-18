import path from "node:path";
import readline from "node:readline/promises";
import {
  planUninstall,
  runUninstall,
  type UninstallReport,
} from "../../application/uninstall/uninstall.js";
import {
  shimDirectory,
  stripInterceptionBlocks,
} from "../../infrastructure/wrappers/wrapper-manager.js";

export const UNINSTALL_USAGE =
  "Usage: ocean uninstall [--yes] [--purge] [--json]";

// Deleting the workspace cannot be undone, so `--purge` asks once more, on a terminal only:
// the person types the workspace folder's name.
async function confirmPurge(root: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const name = path.basename(root);
    const answer = await terminal.question(
      `This deletes ${root} — memory, tasks, sessions — and cannot be undone.\nType "${name}" to delete it: `,
    );
    return answer.trim() === name;
  } finally {
    terminal.close();
  }
}

const wiring = () => ({
  shimDir: shimDirectory(),
  stripProfile: stripInterceptionBlocks,
});

function printReport(report: UninstallReport): void {
  for (const item of report.removed)
    console.log(`removed  ${item.area.padEnd(9)} ${item.target}`);
  for (const item of report.left)
    console.log(`left     ${item.area.padEnd(9)} ${item.target}`);
  if (report.purged) console.log(`deleted  workspace ${report.purged}`);
  console.log("\nNext:");
  for (const step of report.next) console.log(`  - ${step}`);
}

export async function runUninstallCommand(args: string[]): Promise<void> {
  const known = new Set(["--yes", "--purge", "--json"]);
  const unknown = args.find((arg) => !known.has(arg));
  if (unknown) {
    console.error(`Unknown uninstall argument: ${unknown}\n${UNINSTALL_USAGE}`);
    process.exitCode = 1;
    return;
  }
  const json = args.includes("--json");
  let purge = args.includes("--purge");
  const plan = await planUninstall({ ...wiring(), purge });
  if (!args.includes("--yes")) {
    if (json) console.log(JSON.stringify({ dryRun: true, ...plan }, null, 2));
    else {
      console.log("ocean uninstall would remove (nothing is changed yet):");
      for (const item of plan.items)
        console.log(`  ${item.area.padEnd(9)} ${item.target}`);
      if (plan.purge) console.log(`  workspace ${plan.purge} (DELETED)`);
      else if (plan.refusal) console.log(`  workspace kept: ${plan.refusal}`);
      else console.log("  workspace kept (add --purge to delete it)");
      console.log("\nRun `ocean uninstall --yes` to do it.");
    }
    return;
  }
  if (purge && plan.purge && !(await confirmPurge(plan.purge))) {
    console.error(
      "Workspace kept: deleting it needs the folder name typed at a terminal.",
    );
    purge = false;
  }
  const report = await runUninstall({ ...wiring(), purge });
  if (json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  if (report.left.length) process.exitCode = 1;
}
