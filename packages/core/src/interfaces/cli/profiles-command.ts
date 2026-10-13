import {
  applyProfileUpgrade,
  planProfileUpgrade,
  rollbackProfileUpgrade,
  validateProfiles,
} from "../../application/profiles/profile-upgrade-service.js";
import { loadProfile } from "../../infrastructure/filesystem/profile-loader.js";

const usage =
  "Usage: ocean profiles validate | ocean profiles upgrade --check | --apply | --rollback";

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export async function runProfilesCommand(args: string[]): Promise<void> {
  const [action, mode] = args;
  try {
    if (action === "validate") {
      const results = await validateProfiles(loadProfile);
      print(results);
      if (results.some((result) => !result.ok)) process.exitCode = 1;
      return;
    }
    if (action === "upgrade" && mode === "--check") {
      const plan = await planProfileUpgrade();
      // The manifest shows what would change; the new file contents are not printed.
      print(plan.map(({ next: _next, ...entry }) => entry));
      if (plan.some((e) => e.status === "rejected" || e.status === "collision"))
        process.exitCode = 1;
      return;
    }
    if (action === "upgrade" && mode === "--apply") {
      const result = await applyProfileUpgrade();
      print({
        applied: result.applied,
        blocked: result.blocked.map(({ next: _next, ...entry }) => entry),
      });
      if (result.blocked.length) process.exitCode = 1;
      return;
    }
    if (action === "upgrade" && mode === "--rollback") {
      const result = await rollbackProfileUpgrade();
      print(result);
      if (result.skipped.length) process.exitCode = 1;
      return;
    }
    console.error(usage);
    process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
