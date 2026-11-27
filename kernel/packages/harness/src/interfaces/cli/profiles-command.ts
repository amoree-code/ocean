import { profileCatalog } from "@ocean/core/shared/session-profile.js";
import {
  profileDoctor,
  readSelections,
  selectionsLog,
} from "../../application/profiles/profile-doctor.js";
import {
  applyProfileMigration,
  planProfileMigration,
  rollbackProfileMigration,
} from "../../application/profiles/profile-migration-service.js";
import { selectProfileForTask } from "../../application/profiles/profile-suggestion.js";
import {
  applyProfileUpgrade,
  planProfileUpgrade,
  rollbackProfileUpgrade,
  validateProfiles,
} from "../../application/profiles/profile-upgrade-service.js";
import { loadProfile } from "../../infrastructure/filesystem/profile-loader.js";

const usage =
  "Usage: ocean profiles doctor [--days <n>] [--json] | validate | upgrade --check | --apply | --rollback | migrate --check | --apply | --rollback | suggest --task <id> [--profile <name>]";

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export async function runProfilesCommand(args: string[]): Promise<void> {
  const [action, mode] = args;
  try {
    // T-338 P5: the selection log read back as findings and suggestions; never edits anything.
    if (action === "doctor") {
      const daysAt = args.indexOf("--days");
      const days = daysAt >= 0 ? Number(args[daysAt + 1]) : 30;
      if (!Number.isInteger(days) || days <= 0) throw new Error(usage);
      const catalog = await profileCatalog();
      const report = profileDoctor(
        await readSelections(),
        catalog.profiles.map((profile) => profile.name),
        { days, log: selectionsLog() },
      );
      if (args.includes("--json")) {
        print(report);
        return;
      }
      const counts = (record: Record<string, number>) =>
        Object.entries(record)
          .sort((a, b) => b[1] - a[1])
          .map(([name, count]) => `${name} ${count}`)
          .join(", ") || "none";
      console.log(
        `Profile selections, last ${report.days} days: ${report.sessions} sessions, ${report.tasks} tasks${report.unreadable ? `, ${report.unreadable} unreadable lines` : ""}`,
      );
      console.log(`  profiles: ${counts(report.byProfile)}`);
      console.log(`  session confidence: ${counts(report.byConfidence)}`);
      if (!report.findings.length) console.log("No routing findings.");
      for (const finding of report.findings) {
        console.log(`- ${finding.kind}: ${finding.detail}`);
        console.log(`  suggest: ${finding.suggestion}`);
      }
      return;
    }
    if (action === "suggest") {
      const value = (flag: string) => {
        const index = args.indexOf(flag);
        return index >= 0 ? args[index + 1] : undefined;
      };
      const task = value("--task");
      if (!task) throw new Error(usage);
      print(
        await selectProfileForTask(task, {
          cwd: process.cwd(),
          override: value("--profile"),
        }),
      );
      return;
    }
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
        ...(result.applied.length
          ? {
              note: "Upgraded profiles have a new identity: sessions created before the upgrade cannot be resumed. `ocean profiles upgrade --rollback` restores the v1 files.",
            }
          : {}),
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
    // T-338: JSON profiles → Markdown. Identity is unchanged, so sessions still resume.
    if (action === "migrate" && mode === "--check") {
      const plan = await planProfileMigration();
      print(plan.map(({ next: _next, ...entry }) => entry));
      if (plan.some((e) => e.status === "rejected" || e.status === "collision"))
        process.exitCode = 1;
      return;
    }
    if (action === "migrate" && mode === "--apply") {
      const result = await applyProfileMigration();
      print({
        migrated: result.migrated,
        blocked: result.blocked.map(({ next: _next, ...entry }) => entry),
        ...(result.migrated.length
          ? {
              note: "`ocean profiles migrate --rollback` restores the JSON files while the Markdown files are unedited.",
            }
          : {}),
      });
      if (result.blocked.length) process.exitCode = 1;
      return;
    }
    if (action === "migrate" && mode === "--rollback") {
      const result = await rollbackProfileMigration();
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
