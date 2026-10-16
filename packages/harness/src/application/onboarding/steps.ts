import { writeFile } from "node:fs/promises";
import type { ProviderRecord } from "@ocean/core/domain/providers/provider.js";
import { oceanPath, PERSONAL_DIR } from "@ocean/core/shared/paths.js";
import {
  copyClientSkills,
  populateSkillHub,
} from "@ocean/market/skills/skill-hub.js";
import { connectObsidianVault } from "../obsidian/vault-discovery.js";

// Bump when a step is added; completed steps stay completed, only new ids run.
export const ONBOARDING_VERSION = 2;

export type OnboardingIO = {
  interactive: boolean;
  say(line: string): void;
  ask(question: string, fallback: string): Promise<string>;
};

export type OnboardingStep = {
  id: string;
  title: string;
  // `optional` steps are skipped (not run) when non-interactive.
  optional: boolean;
  run(io: OnboardingIO): Promise<"done" | "skipped">;
};

// The wrapper operations the steps run. The CLI passes the wrapper manager's, so this
// application module never imports an infrastructure concrete (T-218).
export type OnboardingWrappers = {
  wrapperStatus(): Promise<ProviderRecord[]>;
  setProviderEnabled(id: string, enabled: boolean): Promise<unknown>;
  syncProviderWrappers(): Promise<unknown>;
  installShellIntegration(): Promise<string>;
  wrapperDoctor(): Promise<string[]>;
};

export type StepDependencies = {
  setup(): Promise<void>;
  wrappers: OnboardingWrappers;
};

async function yes(io: OnboardingIO, question: string): Promise<boolean> {
  return (await io.ask(`${question} [Y/n] `, "y")).trim().toLowerCase() !== "n";
}

// A guided step prints the exact command instead of running it: these touch client
// configs, credentials or the user's own settings, which Ocean must not edit unasked.
function guided(
  id: string,
  title: string,
  lines: string[],
  optional = true,
): OnboardingStep {
  return {
    id,
    title,
    optional,
    async run(io) {
      lines.forEach((line) => {
        io.say(`    ${line}`);
      });
      return (await yes(io, "  Done, or will do it later?"))
        ? "done"
        : "skipped";
    },
  };
}

export function buildSteps(deps: StepDependencies): OnboardingStep[] {
  return [
    {
      id: "workspace",
      title: "Workspace (folders, default profile, permissions)",
      optional: false,
      async run() {
        await deps.setup();
        return "done";
      },
    },
    {
      id: "identity",
      title: "Identity (who Ocean works for)",
      optional: true,
      async run(io) {
        const name = (await io.ask("  Your name: ", "")).trim();
        const role = (await io.ask("  Your role: ", "")).trim();
        const language = (await io.ask("  Preferred language: ", "")).trim();
        if (!name && !role && !language) return "skipped";
        await writeFile(
          oceanPath(PERSONAL_DIR, "identity.md"),
          `# Identity\n\n- Name: ${name}\n- Role: ${role}\n- Language: ${language}\n`,
          { flag: "wx" },
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
          io.say("  identity.md already exists; left unchanged.");
        });
        return "done";
      },
    },
    {
      id: "clients",
      title: "AI clients (which CLIs Ocean observes)",
      optional: false,
      async run(io) {
        for (const client of await deps.wrappers.wrapperStatus()) {
          const state = client.enabled ? "enabled" : "disabled";
          io.say(`  ${client.id.padEnd(12)} ${state}`);
          if (!io.interactive) continue;
          const enable = await yes(io, `  Observe ${client.id}?`);
          if (enable !== client.enabled)
            await deps.wrappers.setProviderEnabled(client.id, enable);
        }
        await deps.wrappers.syncProviderWrappers();
        return "done";
      },
    },
    {
      id: "skills",
      title: "Skills (one store in Ocean, clients hold copies)",
      optional: false,
      async run(io) {
        const hub = await populateSkillHub();
        io.say(
          `  Hub: ${hub.added.length} added, ${hub.kept.length} already there.`,
        );
        const plan = await copyClientSkills({});
        const pending = plan.actions.filter((a) => a.action !== "synchronized");
        if (pending.length === 0) {
          io.say("  Clients already hold a copy of every hub skill.");
          return "done";
        }
        io.say(
          `  ${pending.length} client skill copies are out of date (originals are backed up).`,
        );
        if (!io.interactive) {
          io.say("  Run: ocean skill copy --apply");
          return "skipped";
        }
        if (!(await yes(io, "  Apply now?"))) return "skipped";
        const applied = await copyClientSkills({ apply: true });
        io.say(`  Copied. Backup: ${applied.backup ?? "none needed"}`);
        return "done";
      },
    },
    {
      id: "shell",
      title: "Shell integration",
      optional: false,
      async run(io) {
        io.say(
          `  Shim directory on PATH via ${await deps.wrappers.installShellIntegration()}`,
        );
        return "done";
      },
    },
    guided("mcp", "MCP config for your clients", [
      "Run: ocean mcp config",
      "Paste the JSON into each client's MCP settings.",
    ]),
    guided("auth", "Provider authentication", [
      "Run: ocean auth",
      "Credentials stay in the OS keychain or environment, never in files.",
    ]),
    guided("browser", "Browser capability", ["Run: ocean browser"]),
    {
      id: "obsidian",
      title: "Obsidian vault",
      optional: true,
      async run(io) {
        const vault = (
          await io.ask("  Vault path (blank to skip): ", "")
        ).trim();
        if (!vault) return "skipped";
        const result = await connectObsidianVault(vault, "read-only");
        io.say(`  Connected ${result.vaultPath} (${result.noteCount} notes)`);
        return "done";
      },
    },
    guided("hooks", "SessionStart auto-sync hook", [
      "Add before the exec in your session-bootstrap hook:",
      'node "$HOME/ocean/kernel/packages/harness/dist/main.js" client sync >/dev/null 2>&1 &',
    ]),
    guided("service", "Background service and schedules", [
      "Run: ocean service   (and ocean schedule for recurring jobs)",
    ]),
    {
      id: "verify",
      title: "Verify",
      optional: false,
      async run(io) {
        const findings = await deps.wrappers.wrapperDoctor();
        // PATH is read from this process, which predates the profile edit made in the
        // shell step, so that one finding only means "open a new terminal".
        const pathNote = findings.filter((finding) =>
          finding.includes("not on PATH"),
        );
        const blocking = findings.filter(
          (finding) => !pathNote.includes(finding),
        );
        pathNote.forEach(() => {
          io.say("  Open a new terminal so the shim directory is on PATH.");
        });
        blocking.forEach((finding) => {
          io.say(`  NOT READY: ${finding}`);
        });
        if (findings.length === 0)
          io.say(
            "  PROVEN: wrappers configured, binaries resolve outside the shim directory.",
          );
        if (blocking.length > 0) {
          io.say("  Fix the above, then run: ocean onboard --reset verify");
          return "skipped";
        }
        io.say("  Also run: ocean doctor");
        return "done";
      },
    },
  ];
}
