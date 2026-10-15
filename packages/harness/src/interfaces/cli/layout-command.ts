import {
  applyLayout,
  rollbackLayout,
} from "../../application/layout/layout-apply.js";
import { planLayout } from "../../application/layout/layout-plan.js";
import { oceanRoot } from "../../paths.js";

const USAGE = "Usage: ocean layout plan | apply --yes | rollback --yes";

export async function runLayoutCommand(args: string[]): Promise<void> {
  // Built and rehearsed for the macOS/Linux workspace (HOME-relative pointers, POSIX symlinks and
  // modes); on Windows the home folder, links and permissions behave differently and are untested.
  if (process.platform === "win32")
    throw new Error("ocean layout supports macOS and Linux only.");
  const action = args[0] ?? "plan";
  const confirmed = args.includes("--yes");
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (action === "plan") return print(await planLayout(oceanRoot()));
  if (action !== "apply" && action !== "rollback") throw new Error(USAGE);
  // Both write outside the workspace (client config, shell files), so neither runs by accident.
  if (!confirmed) {
    print(await planLayout(oceanRoot()));
    throw new Error(
      `ocean layout ${action} changes files outside the workspace; review the plan above, then re-run with --yes.`,
    );
  }
  if (action === "apply") print(await applyLayout(oceanRoot()));
  else print(await rollbackLayout(oceanRoot()));
}
