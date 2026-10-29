import { readFile } from "node:fs/promises";
import path from "node:path";
import { learnFromSession } from "@ocean/brain/memory/lesson-learning.js";
import {
  addLesson,
  effectiveConfidence,
  listLessons,
  migrateLegacyLessons,
  readLesson,
  setLessonStatus,
} from "@ocean/brain/memory/lessons.js";
import { promoteSessionToKnowledge } from "@ocean/brain/memory/session-promotion.js";
import { classifyIntent } from "@ocean/context/context/intent-router.js";
import { resolveProfileName } from "@ocean/core/domain/profiles/runtime-config.js";
import {
  oceanEnv,
  oceanPath,
  oceanRoot,
  SYSTEM_DIR,
} from "@ocean/core/shared/paths.js";
import {
  autoRegisterProject,
  bindProject,
  findGitRoot,
  knownTaskPrefixes,
  listProjectBindings,
  migrateProjectBindings,
  renameProject,
  renderProjectIndex,
  resolveProject,
  scanProjectManifests,
  unbindProjectPath,
  writeProjectIndex,
} from "@ocean/core/shared/project-resolution.js";
import { claudeSessionEndHook } from "@ocean/loop/hooks/session-end-hook.js";
import {
  isSessionStartClient,
  readBoundedStdin,
  SESSION_START_CLIENTS,
  sessionStartHookForClient,
} from "@ocean/loop/hooks/session-start-hook.js";
import { openSessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";
import {
  listTaskLoops,
  runTaskLoopsOnce,
  runTaskLoopWorker,
  startTaskLoop,
  stopTaskLoop,
} from "@ocean/loop/loops/task-loop.js";
import { resumeAgent, runAgent } from "@ocean/loop/runs/run-agent.js";
import {
  applyRetention,
  DEFAULT_KEEP_DAYS,
  planRetention,
  simulateRetention,
} from "@ocean/loop/sessions/session-retention.js";
import {
  mcpClientConfig,
  oceanMcpConfig,
  playwrightMcpConfig,
} from "@ocean/market/mcp/mcp-connection.js";
import { GATEWAY_CAPABILITY } from "@ocean/market/mcp/mcp-gateway.js";
import {
  coreSkillReports,
  syncCoreSkills,
} from "@ocean/market/skills/core-skill-sync.js";
import {
  copyClientSkills,
  linkClientSkills,
  populateSkillHub,
} from "@ocean/market/skills/skill-hub.js";
import {
  hasFailures,
  repairWorkspace,
  workspaceReport,
} from "@ocean/services/doctor/workspace-doctor.js";
import { runObsidianMcpServer } from "@ocean/services/infrastructure/mcp/obsidian-server.js";
import { runOceanMcpServer } from "@ocean/services/infrastructure/mcp/ocean-server.js";
import {
  parseConflictSide,
  resolveConflict,
} from "@ocean/services/obsidian/conflict-log.js";
import {
  listInboxCandidates,
  promoteInboxNote,
} from "@ocean/services/obsidian/inbox-promotion.js";
import {
  connectObsidianVault,
  discoverObsidianVault,
  loadObsidianConnection,
} from "@ocean/services/obsidian/vault-discovery.js";
import {
  syncObsidianVault,
  watchObsidianVault,
} from "@ocean/services/obsidian/vault-sync.js";
import { writeObsidianNote } from "@ocean/services/obsidian/vault-writer.js";
import { createWebhookGateway } from "../../application/gateway/webhook-gateway.js";
import {
  findInstallSpec,
  installPlan,
  installProvider,
  listInstallSpecs,
  removeInstalledProvider,
  updateProvider,
} from "../../application/install/provider-installer.js";
import { syncCharterCopies } from "../../application/integrations/charter-copies.js";
import { configureClaudeCodeWrapper } from "../../application/integrations/claude-vscode.js";
import { repairEngineEntries } from "../../application/integrations/engine-entry-repair.js";
import { syncSkillFilter } from "../../application/integrations/skill-filter.js";
import {
  releaseRuntime,
  releaseStatus,
  useRelease,
} from "../../application/release/runtime-release.js";
import {
  listSchedules,
  runDueSchedules,
  runSchedule,
  runSchedulerWorker,
  runSchedulerWorkerOnce,
  saveSchedule,
  setScheduleEnabled,
} from "../../application/scheduler/local-scheduler.js";
import {
  defaultAgentRuntime,
  defaultBrainIndexPort,
  defaultProviderRegistry,
  defaultSessionStoreFactory,
  defaultSessionStoreOpener,
  defaultWrapperManager,
} from "../../composition/runtime.js";
import { loadRuntimeConfig } from "../../infrastructure/filesystem/runtime-config-loader.js";
import { runService } from "../../infrastructure/process/service.js";
import { loadProviderRegistry } from "../../infrastructure/providers/provider-registry.js";
import {
  installShellPath,
  registerProvider,
  setProviderEnabled,
  syncProviderWrappers,
  wrapperDoctor,
  wrapperStatus,
} from "../../infrastructure/wrappers/wrapper-manager.js";
import { runAuthCommand } from "./auth-command.js";
import { runBrowserCommand } from "./browser-command.js";
import { runCaptureCommand } from "./capture-command.js";
import { runClientTestCommand } from "./client-test-command.js";
import { runContextCommand, runContextCostCommand } from "./context-command.js";
import { runDailyCommand } from "./daily-command.js";
import { runLifecycleCommand, runPolicyCommand } from "./governance-command.js";
import { runHandoffCommand } from "./handoff-command.js";
import { runIdeaCommand } from "./idea-command.js";
import { intercept } from "./intercept-command.js";
import { runLayoutCommand } from "./layout-command.js";
import { runMarketCommand } from "./market-command.js";
import { runMcpGatewayCommand } from "./mcp-gateway-command.js";
import { runMemoryCommand } from "./memory-command.js";
import { runMigrateCommand } from "./migrate-command.js";
import { runObserveCommand } from "./observe-command.js";
import { manageClients, runOnboardCommand } from "./onboard-command.js";
import { runOperateCommand } from "./operate-command.js";
import { runProfilesCommand } from "./profiles-command.js";
import { setup } from "./setup-command.js";
import { runTasksCommand } from "./tasks-command.js";

export type CommandHandler = () => Promise<void> | void;

async function commandSetup(): Promise<void> {
  const obsidianIndex = process.argv.indexOf("--obsidian");
  const obsidianPath =
    obsidianIndex >= 0 ? process.argv[obsidianIndex + 1] : undefined;
  if (obsidianIndex >= 0 && !obsidianPath) {
    console.error(
      "Usage: ocean setup [--obsidian <vault-path>] [--read-write]",
    );
    process.exitCode = 1;
  } else {
    await setup({
      obsidianPath,
      obsidianMode: process.argv.includes("--read-write")
        ? "read-write"
        : "read-only",
    });
  }
}

async function commandService(): Promise<void> {
  const shutdownAfterMs = Number(oceanEnv("SERVICE_TEST_SHUTDOWN_MS"));
  await runService(
    Number.isFinite(shutdownAfterMs) && shutdownAfterMs > 0
      ? shutdownAfterMs
      : undefined,
  );
}

async function commandIntercept(): Promise<void> {
  const clientIndex = process.argv.indexOf("--client");
  const executableIndex = process.argv.indexOf("--executable");
  const separatorIndex = process.argv.indexOf("--");
  const client = clientIndex >= 0 ? process.argv[clientIndex + 1] : "";
  const args =
    separatorIndex >= 0 ? process.argv.slice(separatorIndex + 1) : [];
  if (!client) {
    console.error("Usage: ocean intercept --client <provider> -- [args]");
    process.exitCode = 1;
  } else {
    process.exitCode = await intercept(
      client,
      args,
      executableIndex >= 0
        ? {
            originalExecutable: process.argv[executableIndex + 1],
            entryPoint: "desktop-wrapper",
            controlLevel: "managed-partial",
          }
        : undefined,
    );
  }
}

async function commandClient(): Promise<void> {
  const action = process.argv[3] ?? "list";
  if (action === "list") {
    console.log(JSON.stringify(loadProviderRegistry(), null, 2));
  } else if (action === "open") {
    const provider = process.argv[4];
    if (!provider) {
      console.error("Usage: ocean client open <provider> [provider-args]");
      process.exitCode = 1;
    } else {
      const providerArgs = process.argv.slice(5);
      const taskIndex = providerArgs.indexOf("--task");
      const handoffIndex = providerArgs.indexOf("--handoff");
      const taskId = taskIndex >= 0 ? providerArgs[taskIndex + 1] : undefined;
      const handoffId =
        handoffIndex >= 0 ? providerArgs[handoffIndex + 1] : undefined;
      const metadataFlags = new Set<number>();
      if (taskIndex >= 0) {
        metadataFlags.add(taskIndex);
        metadataFlags.add(taskIndex + 1);
      }
      if (handoffIndex >= 0) {
        metadataFlags.add(handoffIndex);
        metadataFlags.add(handoffIndex + 1);
      }
      process.exitCode = await intercept(
        provider,
        providerArgs.filter((_, index) => !metadataFlags.has(index)),
        {
          entryPoint: "interactive-managed",
          controlLevel: "managed-partial",
          taskId,
          handoffId,
        },
      );
    }
  } else if (action === "sync") {
    const result = await syncProviderWrappers();
    // Runs at every session start (the SessionStart hook calls `client sync`), so an edit
    // to core.md reaches the clients that carry a copy without a manual step.
    const charter = await syncCharterCopies();
    const skillFilter = await syncSkillFilter();
    const engineEntries = await repairEngineEntries();
    console.log(
      JSON.stringify(
        {
          directory: result.directory,
          providers: result.providers,
          charter,
          skillFilter,
          engineEntries,
        },
        null,
        2,
      ),
    );
  } else if (action === "register") {
    const id = process.argv[4];
    const provider = await registerProvider(
      id ?? "",
      process.argv[5] ?? id ?? "",
    );
    console.log(JSON.stringify(provider, null, 2));
  } else if (action === "enable" || action === "disable") {
    const id = process.argv[4];
    if (!id) {
      console.error(`Usage: ocean client ${action} <provider>`);
      process.exitCode = 1;
    } else {
      const provider = await setProviderEnabled(id, action === "enable");
      console.log(JSON.stringify(provider, null, 2));
    }
  } else if (action === "manage") {
    await manageClients();
  } else if (action === "doctor") {
    const findings = await wrapperDoctor(process.argv[4]);
    if (findings.length) {
      findings.forEach((finding) => {
        console.error(`NOT READY: ${finding}`);
      });
      process.exitCode = 1;
    } else {
      console.log(
        "PROVEN: Ocean wrappers are configured and provider binaries resolve outside the shim directory.",
      );
    }
  } else if (action === "status") {
    console.log(JSON.stringify(await wrapperStatus(), null, 2));
  } else if (action === "vscode-wrapper") {
    const settingsIndex = process.argv.indexOf("--settings");
    const settingsPath =
      settingsIndex >= 0 ? process.argv[settingsIndex + 1] : undefined;
    console.log(
      JSON.stringify(
        await configureClaudeCodeWrapper(
          defaultWrapperManager,
          settingsPath,
          process.argv.includes("--apply"),
        ),
        null,
        2,
      ),
    );
  } else if (action === "test") {
    const provider =
      process.argv[4] === "--json" ? "" : (process.argv[4] ?? "");
    await runClientTestCommand(provider, process.argv.includes("--json"));
  } else {
    console.error(
      "Usage: ocean client list|status|test [provider] [--json]|open <provider> [provider-args]|vscode-wrapper [--settings <path>] [--apply]|sync|register <id> [command]|enable <id>|disable <id>|manage|doctor [absolute-provider-path]",
    );
    process.exitCode = 1;
  }
}

async function commandInstall(): Promise<void> {
  const id = process.argv[3];
  if (!id) {
    console.error("Usage: ocean install <client> [--yes]");
    process.exitCode = 1;
  } else {
    try {
      const spec = findInstallSpec(id);
      if (!process.argv.includes("--yes")) {
        console.log(
          JSON.stringify(
            { approvalRequired: true, plan: installPlan(spec.provider.id) },
            null,
            2,
          ),
        );
        process.exitCode = 2;
      } else {
        const result = await installProvider(
          spec.provider.id,
          true,
          defaultWrapperManager,
          defaultProviderRegistry,
        );
        console.log(
          JSON.stringify(
            {
              installed: true,
              provider: result.provider,
              executable: result.executable,
            },
            null,
            2,
          ),
        );
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}

async function commandAuth(): Promise<void> {
  await runAuthCommand(process.argv[3] ?? "", process.argv[4] ?? "");
}

async function commandTasks(): Promise<void> {
  await runTasksCommand(process.argv[3] ?? "", process.argv.slice(4));
}

async function commandPolicy(): Promise<void> {
  try {
    await runPolicyCommand(process.argv[3] ?? "list");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function commandMarket(): Promise<void> {
  try {
    await runMarketCommand(process.argv[3] ?? "", process.argv.slice(4));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function commandLifecycle(): Promise<void> {
  await runLifecycleCommand(process.argv.slice(3));
}

async function commandObserve(): Promise<void> {
  try {
    await runObserveCommand(process.argv.slice(3));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function commandLayout(): Promise<void> {
  try {
    await runLayoutCommand(process.argv.slice(3));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function commandMigrate(): Promise<void> {
  await runMigrateCommand(process.argv.includes("--apply"));
}

async function commandMemory(): Promise<void> {
  await runMemoryCommand(process.argv[3] ?? "", process.argv.slice(4));
}

async function commandMcp(): Promise<void> {
  const action = process.argv[3] ?? "config";
  if (action === "config")
    console.log(JSON.stringify(oceanMcpConfig(), null, 2));
  else if (action === "playwright-config")
    console.log(JSON.stringify(playwrightMcpConfig(), null, 2));
  else if (action === "gateway-config")
    console.log(JSON.stringify(mcpClientConfig(GATEWAY_CAPABILITY), null, 2));
  else if (action === "serve")
    await runOceanMcpServer({
      brainIndex: defaultBrainIndexPort,
      sessionStoreFactory: defaultSessionStoreFactory,
      wrapperManager: defaultWrapperManager,
    });
  else if (action === "gateway") await runMcpGatewayCommand();
  else {
    console.error(
      "Usage: ocean mcp config|playwright-config|gateway-config|serve|gateway",
    );
    process.exitCode = 1;
  }
}

async function commandObsidian(): Promise<void> {
  const action = process.argv[3] ?? "discover";
  if (action === "mcp") await runObsidianMcpServer();
  else if (
    ![
      "connect",
      "discover",
      "sync",
      "watch",
      "inbox",
      "write",
      "conflicts",
    ].includes(action)
  ) {
    console.error(
      "Usage: ocean obsidian connect <vault-path> [--read-write]|discover|sync|watch|inbox|write|conflicts resolve <id> --keep=vault|ocean",
    );
    process.exitCode = 1;
  } else {
    try {
      if (action === "connect") {
        const vaultPath = process.argv[4];
        if (!vaultPath)
          throw new Error(
            "Usage: ocean obsidian connect <vault-path> [--read-write]",
          );
        const readWrite = process.argv.includes("--read-write");
        const mode = readWrite
          ? ("read-write" as const)
          : ("read-only" as const);
        const result = await connectObsidianVault(vaultPath, mode);
        const synced = await syncObsidianVault(await loadObsidianConnection());
        console.log(
          JSON.stringify(
            {
              connected: true,
              mode,
              vaultPath: result.vaultPath,
              noteCount: synced.noteCount,
              added: synced.added,
              changed: synced.changed,
              removed: synced.removed,
              issues: synced.issues,
            },
            null,
            2,
          ),
        );
      } else {
        const connection = await loadObsidianConnection();
        if (action === "conflicts") {
          if (process.argv[4] !== "resolve")
            throw new Error(
              "Usage: ocean obsidian conflicts resolve <id> --keep=vault|ocean",
            );
          const id = process.argv[5];
          const keepArg = process.argv.find((arg) => arg.startsWith("--keep="));
          const keep = keepArg?.slice("--keep=".length);
          if (!id || !keep || !parseConflictSide(keep))
            throw new Error(
              "Usage: ocean obsidian conflicts resolve <id> --keep=vault|ocean",
            );
          console.log(JSON.stringify(await resolveConflict(id, keep), null, 2));
        } else if (action === "write") {
          const relative = process.argv[4];
          const content = process.argv[5];
          const expectedSha256 = process.argv[6] ?? null;
          if (!relative || content === undefined)
            throw new Error(
              "Usage: ocean obsidian write <relative.md> <content> [expected-sha256] [--apply]",
            );
          console.log(
            JSON.stringify(
              await writeObsidianNote(
                connection,
                relative,
                content,
                expectedSha256 === "-" ? null : expectedSha256,
                process.argv.includes("--apply"),
              ),
              null,
              2,
            ),
          );
        } else if (action === "inbox") {
          const inboxAction = process.argv[4] ?? "list";
          if (inboxAction === "list")
            console.log(
              JSON.stringify(await listInboxCandidates(connection), null, 2),
            );
          else if (inboxAction === "promote") {
            const source = process.argv[5];
            const target = process.argv[6];
            if (!source || !target)
              throw new Error(
                "Usage: ocean obsidian inbox promote <source.md> <target-directory> [--apply]",
              );
            console.log(
              JSON.stringify(
                await promoteInboxNote(
                  connection,
                  source,
                  target,
                  process.argv.includes("--apply"),
                ),
                null,
                2,
              ),
            );
          } else
            throw new Error(
              "Usage: ocean obsidian inbox list|promote <source.md> <target-directory> [--apply]",
            );
        } else if (action === "discover")
          console.log(
            JSON.stringify(await discoverObsidianVault(connection), null, 2),
          );
        else if (action === "sync")
          console.log(
            JSON.stringify(await syncObsidianVault(connection), null, 2),
          );
        else {
          const controller = new AbortController();
          process.once("SIGINT", () => controller.abort());
          process.once("SIGTERM", () => controller.abort());
          await watchObsidianVault(connection, undefined, controller.signal);
        }
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}

async function commandCapture(): Promise<void> {
  await runCaptureCommand(process.argv[3] ?? "", process.argv.slice(4));
}

async function commandHandoff(): Promise<void> {
  try {
    await runHandoffCommand(process.argv[3] ?? "list", process.argv.slice(4));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function commandContext(): Promise<void> {
  if (process.argv[3] === "cost") {
    await runContextCostCommand(process.argv.slice(4));
    return;
  }
  await runContextCommand(process.argv.includes("--json"));
}

async function commandProject(): Promise<void> {
  const action = process.argv[3] ?? "resolve";
  if (action === "resolve") {
    console.log(
      JSON.stringify(
        await resolveProject(process.argv[4] ?? process.cwd()),
        null,
        2,
      ),
    );
  } else if (action === "bind") {
    const args = process.argv.slice(4);
    const addPath = args.includes("--add");
    const [name, targetPath] = args.filter((arg) => arg !== "--add");
    if (!name || !targetPath) {
      console.error("Usage: ocean project bind <name> <path> [--add]");
      process.exitCode = 1;
    } else {
      const result = await bindProject(name, targetPath, { addPath });
      console.log(JSON.stringify(result, null, 2));
      if (result.conflict) process.exitCode = 2;
    }
  } else if (action === "list") {
    const { errors } = await scanProjectManifests();
    for (const { file, error } of errors)
      console.error(`skipped invalid ${file}: ${error}`);
    const bindings = (await listProjectBindings()).map((binding) => ({
      ...binding,
      gitRoot: binding.gitRoot ?? findGitRoot(binding.path),
    }));
    console.log(JSON.stringify(bindings, null, 2));
    if (errors.length) process.exitCode = 2;
  } else if (action === "register") {
    const result = await autoRegisterProject(process.argv[4] ?? process.cwd(), {
      explicit: true,
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "registered") process.exitCode = 2;
  } else if (action === "unbind") {
    const target = process.argv[4];
    if (!target) {
      console.error("Usage: ocean project unbind <path>");
      process.exitCode = 1;
    } else {
      const result = await unbindProjectPath(target);
      console.log(JSON.stringify(result, null, 2));
      if (!result.removed) process.exitCode = 2;
    }
  } else if (action === "rename") {
    const [from, to] = process.argv.slice(4);
    if (!from || !to) {
      console.error("Usage: ocean project rename <id> <new-id>");
      process.exitCode = 1;
    } else {
      try {
        console.log(JSON.stringify(await renameProject(from, to), null, 2));
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      }
    }
  } else if (action === "migrate") {
    const result = await migrateProjectBindings(
      process.argv.includes("--write"),
    );
    console.log(JSON.stringify(result, null, 2));
  } else if (action === "index") {
    if (process.argv.includes("--write"))
      console.log(JSON.stringify(await writeProjectIndex(), null, 2));
    else console.log(await renderProjectIndex());
  } else {
    console.error(
      "Usage: ocean project resolve [path]|bind <name> <path> [--add]|register [path]|unbind <path>|rename <id> <new-id>|list|migrate [--write]|index [--write]",
    );
    process.exitCode = 1;
  }
}

async function commandHook(): Promise<void> {
  const action = process.argv[3] ?? "";
  if (action === "session-start") {
    const flags = process.argv.slice(4);
    const inline = flags.find((arg) => arg.startsWith("--client="));
    const clientIndex = flags.indexOf("--client");
    const client = inline
      ? inline.slice("--client=".length)
      : clientIndex >= 0
        ? (flags[clientIndex + 1] ?? "")
        : "claude";
    if (!isSessionStartClient(client)) {
      console.error(sessionStartUsage);
      process.exitCode = 1;
      return;
    }
    try {
      const raw = await readBoundedStdin();
      const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
      const payload =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed
          : {};
      console.log(
        JSON.stringify(await sessionStartHookForClient(client, payload)),
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } else if (action === "session-end") {
    try {
      const raw = await readBoundedStdin();
      const payload = raw.trim() ? JSON.parse(raw) : {};
      await claudeSessionEndHook(payload, defaultSessionStoreFactory);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } else {
    console.error(
      `${sessionStartUsage}|session-end (reads a hook payload from stdin)`,
    );
    process.exitCode = 1;
  }
}

const sessionStartUsage = `Usage: ocean hook session-start [--client ${SESSION_START_CLIENTS.join("|")}]`;

async function commandIntent(): Promise<void> {
  const action = process.argv[3] ?? "classify";
  if (action !== "classify") {
    console.error("Usage: ocean intent classify <text>");
    process.exitCode = 1;
  } else {
    const text = process.argv.slice(4).join(" ");
    console.log(
      JSON.stringify(classifyIntent(text, await knownTaskPrefixes())),
    );
  }
}

async function commandOperate(): Promise<void> {
  const text = process.argv.slice(3).join(" ");
  await runOperateCommand(text);
}

async function commandIdea(): Promise<void> {
  try {
    await runIdeaCommand(process.argv[3] ?? "list", process.argv.slice(4));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function commandDaily(): Promise<void> {
  try {
    await runDailyCommand(process.argv[3] ?? "start", process.argv.slice(4));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function commandSchedule(): Promise<void> {
  const action = process.argv[3] ?? "list";
  if (action === "list")
    console.log(JSON.stringify(await listSchedules(), null, 2));
  else if (action === "add") {
    const [id, profile, intervalMs, ...prompt] = process.argv.slice(4);
    if (!id || !profile || !intervalMs || !prompt.length) {
      console.error(
        "Usage: ocean schedule add <id> <profile> <interval-ms> <prompt>",
      );
      process.exitCode = 1;
    } else
      await saveSchedule({
        id,
        profile,
        prompt: prompt.join(" "),
        intervalMs: Number(intervalMs),
        nextRunAt: new Date().toISOString(),
        enabled: true,
      });
  } else if (action === "run-due")
    console.log(
      JSON.stringify(
        { ran: await runDueSchedules(oceanRoot(), defaultAgentRuntime) },
        null,
        2,
      ),
    );
  else if (action === "worker-once")
    console.log(
      JSON.stringify(
        { ran: await runSchedulerWorkerOnce(oceanRoot(), defaultAgentRuntime) },
        null,
        2,
      ),
    );
  else if (action === "worker") {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await runSchedulerWorker(oceanRoot(), defaultAgentRuntime, {
      signal: controller.signal,
      pollMs: Number(oceanEnv("SCHEDULER_POLL_MS") ?? 30_000),
    });
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  } else if (action === "enable" || action === "disable")
    console.log(
      JSON.stringify(
        await setScheduleEnabled(process.argv[4] ?? "", action === "enable"),
        null,
        2,
      ),
    );
  else if (action === "run-now")
    await runSchedule(process.argv[4] ?? "", oceanRoot(), defaultAgentRuntime);
  else {
    console.error(
      "Usage: ocean schedule list|add|enable|disable|run-due|run-now|worker-once|worker",
    );
    process.exitCode = 1;
  }
}

async function commandLoop(): Promise<void> {
  const action = process.argv[3] ?? "status";
  if (action === "status")
    console.log(JSON.stringify(await listTaskLoops(), null, 2));
  else if (action === "start") {
    const taskId = process.argv[4];
    const profile = process.argv[5] ?? "developer";
    const promptIndex = process.argv.indexOf("--prompt");
    const prompt =
      promptIndex >= 0 ? process.argv.slice(promptIndex + 1).join(" ") : "";
    if (!taskId || !prompt || !process.argv.includes("--approve")) {
      console.error(
        "Usage: ocean loop start <task-id> <profile> --prompt <text> --approve [--max-iterations N] [--interval-ms N] [--max-attempts N]",
      );
      process.exitCode = 1;
    } else {
      const value = (flag: string, fallback: number) => {
        const index = process.argv.indexOf(flag);
        return index >= 0 ? Number(process.argv[index + 1]) : fallback;
      };
      console.log(
        JSON.stringify(
          await startTaskLoop({
            taskId,
            profile,
            prompt,
            cwd: oceanRoot(),
            approved: true,
            maxIterations: value("--max-iterations", 10),
            intervalMs: value("--interval-ms", 60_000),
            maxAttempts: value("--max-attempts", 2),
          }),
          null,
          2,
        ),
      );
    }
  } else if (action === "worker-once") {
    console.log(
      JSON.stringify(
        { ran: await runTaskLoopsOnce(oceanRoot(), defaultAgentRuntime) },
        null,
        2,
      ),
    );
  } else if (action === "worker") {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await runTaskLoopWorker(oceanRoot(), defaultAgentRuntime, {
      signal: controller.signal,
      pollMs: Number(oceanEnv("LOOP_POLL_MS") ?? 30_000),
    });
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  } else if (action === "stop") {
    const id = process.argv[4];
    if (!id) {
      console.error("Usage: ocean loop stop <loop-id>");
      process.exitCode = 1;
    } else console.log(JSON.stringify(await stopTaskLoop(id), null, 2));
  } else {
    console.error("Usage: ocean loop start|status|stop|worker-once|worker");
    process.exitCode = 1;
  }
}

async function commandGateway(): Promise<void> {
  const port = Number(oceanEnv("GATEWAY_PORT") ?? 8787);
  const token = oceanEnv("GATEWAY_TOKEN");
  if (!token) {
    console.error("OCEAN_GATEWAY_TOKEN is required");
    process.exitCode = 1;
  } else {
    const server = createWebhookGateway(
      oceanRoot(),
      token,
      defaultAgentRuntime,
    );
    server.listen(port, "127.0.0.1", () =>
      console.log(`Ocean webhook gateway listening on 127.0.0.1:${port}`),
    );
  }
}

async function commandSkill(): Promise<void> {
  const action = process.argv[3] ?? "list";
  if (action === "sync")
    console.log(JSON.stringify(await syncCoreSkills(), null, 2));
  else if (action === "hub") {
    const sources = process.argv
      .slice(4)
      .filter((arg) => !arg.startsWith("--"));
    console.log(JSON.stringify(await populateSkillHub(sources), null, 2));
  } else if (action === "copy") {
    console.log(
      JSON.stringify(
        await copyClientSkills({ apply: process.argv.includes("--apply") }),
        null,
        2,
      ),
    );
  } else if (action === "link") {
    console.log(
      JSON.stringify(
        await linkClientSkills({
          apply: process.argv.includes("--apply"),
          all: process.argv.includes("--all"),
        }),
        null,
        2,
      ),
    );
  } else if (action === "doctor")
    console.log(JSON.stringify(await coreSkillReports(), null, 2));
  else if (action === "list") {
    // [status] filters; any other argument is a lesson id (what a truncated lesson points at).
    const filter = process.argv[4];
    const isStatus =
      filter === "candidate" || filter === "active" || filter === "retired";
    const lessons =
      filter && !isStatus
        ? [await readLesson(filter)].filter((lesson) => lesson !== null)
        : await listLessons(isStatus ? { status: filter } : {});
    if (filter && !isStatus && !lessons.length) {
      console.error(`Lesson not found: ${filter}`);
      process.exitCode = 1;
    } else
      console.log(
        JSON.stringify(
          lessons.map((lesson) => ({
            ...lesson,
            effectiveConfidence: Number(effectiveConfidence(lesson).toFixed(4)),
          })),
          null,
          2,
        ),
      );
  } else if (action === "observe" || action === "learn") {
    // Scores one closed session into the lessons store (the same step closeout runs).
    const sessionId = process.argv[4];
    if (!sessionId && action === "observe")
      console.log(
        JSON.stringify(await listLessons({ status: "candidate" }), null, 2),
      );
    else if (!sessionId) {
      console.error("Usage: ocean skill learn <session-id>");
      process.exitCode = 1;
    } else {
      const store = await defaultSessionStoreFactory();
      try {
        console.log(
          JSON.stringify(await learnFromSession(store, sessionId), null, 2),
        );
      } finally {
        store.close();
      }
    }
  } else if (action === "add") {
    const [id, name, ...instructions] = process.argv.slice(4);
    if (!id || !name || !instructions.length) {
      console.error("Usage: ocean skill add <id> <name> <instructions>");
      process.exitCode = 1;
    } else
      console.log(
        JSON.stringify(
          await addLesson({ id, title: name, body: instructions.join(" ") }),
          null,
          2,
        ),
      );
  } else if (action === "review") {
    // The owner's call: promoted activates a lesson without waiting for the replay eval,
    // rejected retires it. Run `ocean memory reindex` afterwards so runs can find it.
    const [id, status] = process.argv.slice(4);
    if (!id || (status !== "promoted" && status !== "rejected")) {
      console.error("Usage: ocean skill review <id> promoted|rejected");
      process.exitCode = 1;
    } else
      console.log(
        JSON.stringify(
          await setLessonStatus(
            id,
            status === "promoted" ? "active" : "retired",
          ),
          null,
          2,
        ),
      );
  } else if (action === "migrate") {
    console.log(JSON.stringify(await migrateLegacyLessons(), null, 2));
  } else {
    console.error(
      "Usage: ocean skill sync|doctor|list [status|id]|observe [session-id]|add|review <id> promoted|rejected|migrate",
    );
    process.exitCode = 1;
  }
}

async function commandCatalog(): Promise<void> {
  console.log(
    JSON.stringify(
      listInstallSpecs().map((spec) => ({
        id: spec.provider.id,
        command: spec.provider.command,
        installer: installPlan(spec.provider.id),
      })),
      null,
      2,
    ),
  );
}

// `ocean runtime release|status|use <id>` (T-294): the build sessions run, apart from the
// kernel checkout. A release takes effect for shims once `client sync` runs from it.
async function commandRuntime(): Promise<void> {
  const action = process.argv[3] ?? "status";
  if (action === "status") {
    console.log(JSON.stringify(await releaseStatus(), null, 2));
    return;
  }
  if (action === "release" || action === "use") {
    const id = process.argv[4];
    if (action === "use" && !id) {
      console.error("Usage: ocean runtime use <release-id>");
      process.exitCode = 2;
      return;
    }
    const result =
      action === "use" ? await useRelease(id) : await releaseRuntime();
    const { entry } = await releaseStatus();
    console.log(
      JSON.stringify(
        {
          ...result,
          next: `node ${entry} client sync   # points the shims at this release`,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.error("Usage: ocean runtime status|release|use <release-id>");
  process.exitCode = 2;
}

async function commandEnv(): Promise<void> {
  console.log(await installShellPath());
}

async function commandUpdateOrRemove(
  command: "update" | "remove",
): Promise<void> {
  const id = process.argv[3];
  if (!id || !process.argv.includes("--yes")) {
    console.error(`Usage: ocean ${command} <client> --yes`);
    process.exitCode = 2;
  } else {
    try {
      const result =
        command === "update"
          ? await updateProvider(
              id,
              true,
              defaultWrapperManager,
              defaultProviderRegistry,
            )
          : await removeInstalledProvider(id, true, defaultWrapperManager);
      console.log(
        JSON.stringify(
          {
            [command === "update" ? "updated" : "removed"]: true,
            provider: result,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}

async function commandDoctor(): Promise<void> {
  const report = await workspaceReport(defaultWrapperManager);
  if (process.argv.includes("--json"))
    console.log(JSON.stringify(report, null, 2));
  else
    report.findings.forEach((finding) => {
      console.log(`${finding.severity}: ${finding.code} — ${finding.message}`);
    });
  if (hasFailures(report.findings)) process.exitCode = 1;
}

async function commandRepair(): Promise<void> {
  const apply = process.argv.includes("--apply");
  if (!apply) {
    const report = await workspaceReport(defaultWrapperManager);
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          fixable: report.findings.filter((finding) => finding.fixable),
          findings: report.findings,
        },
        null,
        2,
      ),
    );
  } else {
    const result = await repairWorkspace(defaultWrapperManager);
    console.log(
      JSON.stringify(
        { applied: result.changes, findings: result.findings },
        null,
        2,
      ),
    );
    if (hasFailures(result.findings)) process.exitCode = 1;
  }
}

async function commandBrowser(): Promise<void> {
  await runBrowserCommand(process.argv[3] ?? "", process.argv.slice(4));
}

async function commandRun(): Promise<void> {
  const profileIndex = process.argv.indexOf("--profile");
  const promptIndex = process.argv.indexOf("--prompt");
  const clientIndex = process.argv.indexOf("--client");
  const taskIndex = process.argv.indexOf("--task");
  const handoffIndex = process.argv.indexOf("--handoff");
  // --profile, then runtime.json's defaultProfile, then the historical "default" while no
  // runtime.json exists. A named profile that does not exist fails; nothing falls back.
  const explicitProfile =
    profileIndex >= 0 ? process.argv[profileIndex + 1] : undefined;
  if (
    profileIndex >= 0 &&
    (!explicitProfile || explicitProfile.startsWith("--"))
  ) {
    console.error("Usage: ocean run --profile <name> ... --prompt <text>");
    process.exitCode = 1;
    return;
  }
  // runtime.json is read only when it is needed, so a broken one cannot block an explicit run.
  const profileName = resolveProfileName(
    explicitProfile,
    explicitProfile ? null : await loadRuntimeConfig(),
  );
  const client = clientIndex >= 0 ? process.argv[clientIndex + 1] : undefined;
  const taskId = taskIndex >= 0 ? process.argv[taskIndex + 1] : undefined;
  const handoffId =
    handoffIndex >= 0 ? process.argv[handoffIndex + 1] : undefined;
  const prompt =
    promptIndex >= 0 ? process.argv.slice(promptIndex + 1).join(" ") : "";
  if (!profileName || !prompt) {
    console.error(
      "Usage: ocean run --profile <name> [--client <client>] [--task <id>] [--handoff <id>] --prompt <text>",
    );
    process.exitCode = 1;
  } else {
    const session = await runAgent(
      { profileName, client, taskId, handoffId, prompt, cwd: oceanRoot() },
      defaultAgentRuntime,
    );
    console.log(
      JSON.stringify({ sessionId: session.sessionId, status: session.status }),
    );
  }
}

async function commandSession(): Promise<void> {
  const action = process.argv[3] ?? "list";
  const store = await openSessionStore();
  if (action === "list") {
    console.log(JSON.stringify(store.list()));
    store.close();
  } else if (action === "show") {
    const sessionId = process.argv[4] ?? "";
    const session = store.get(sessionId);
    const entryEvent = session
      ? store
          .listEvents(sessionId)
          .find((event) => event.type === "session_entry_contract")
      : undefined;
    store.close();
    if (!session) {
      console.error("Session not found");
      process.exitCode = 1;
    } else
      console.log(
        JSON.stringify({
          ...session,
          entryContract: entryEvent ? JSON.parse(entryEvent.data) : null,
        }),
      );
  } else if (action === "summary") {
    const sessionId = process.argv[4] ?? "";
    const session = store.get(sessionId);
    store.close();
    if (!session) {
      console.error("Session not found");
      process.exitCode = 1;
    } else if (!session.summaryPath) {
      console.error("Session summary not available");
      process.exitCode = 1;
    } else {
      try {
        console.log(
          await readFile(
            path.resolve(oceanRoot(), session.summaryPath),
            "utf8",
          ),
        );
      } catch {
        console.error("Session summary file is missing");
        process.exitCode = 1;
      }
    }
  } else if (action === "events") {
    const sessionId = process.argv[4] ?? "";
    const session = store.get(sessionId);
    const events = session ? store.listEvents(sessionId) : [];
    store.close();
    if (!session) {
      console.error("Session not found");
      process.exitCode = 1;
    } else console.log(JSON.stringify(events, null, 2));
  } else if (action === "resume") {
    const sessionId = process.argv[4];
    const prompt = process.argv.slice(5).join(" ");
    store.close();
    if (!sessionId || !prompt) {
      console.error("Usage: ocean session resume <session-id> <prompt>");
      process.exitCode = 1;
    } else {
      const session = await resumeAgent(sessionId, prompt, defaultAgentRuntime);
      console.log(
        JSON.stringify({
          sessionId: session.sessionId,
          status: session.status,
        }),
      );
    }
  } else if (action === "promote") {
    const sessionId = process.argv[4];
    const target = process.argv[5] ?? "knowledge/results";
    store.close();
    if (!sessionId) {
      console.error(
        "Usage: ocean session promote <session-id> [knowledge/<kind>] --approve",
      );
      process.exitCode = 1;
    } else {
      try {
        console.log(
          JSON.stringify(
            await promoteSessionToKnowledge(
              sessionId,
              defaultSessionStoreFactory,
              target,
              process.argv.includes("--approve"),
            ),
            null,
            2,
          ),
        );
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    }
  } else if (action === "doctor") {
    const thresholdHours = Number(process.argv[4] ?? "24");
    const apply = process.argv.includes("--apply");
    if (!Number.isFinite(thresholdHours) || thresholdHours <= 0) {
      store.close();
      console.error("Usage: ocean session doctor [hours] [--apply]");
      process.exitCode = 1;
    } else {
      const thresholdMs = thresholdHours * 60 * 60 * 1000;
      const stale = apply
        ? store.reconcileStaleRunning(thresholdMs)
        : store.listStaleRunning(thresholdMs);
      console.log(
        JSON.stringify({
          apply,
          thresholdHours,
          stale: stale.map((session) => ({
            sessionId: session.sessionId,
            provider: session.provider,
            updatedAt: session.updatedAt,
          })),
          integrity: store.integrityCheck(),
        }),
      );
      store.close();
    }
  } else if (action === "compact") {
    const keepDaysIndex = process.argv.indexOf("--keep-days");
    const keepDays =
      keepDaysIndex >= 0
        ? Number(process.argv[keepDaysIndex + 1])
        : DEFAULT_KEEP_DAYS;
    const simulate = process.argv.includes("--simulate");
    const apply = process.argv.includes("--apply");
    const beforeIndex = process.argv.indexOf("--before");
    const before = beforeIndex >= 0 ? process.argv[beforeIndex + 1] : undefined;
    const planIndex = process.argv.indexOf("--plan");
    const fingerprint =
      planIndex >= 0 ? process.argv[planIndex + 1] : undefined;
    if (!Number.isFinite(keepDays) || keepDays <= 0) {
      store.close();
      console.error(
        "Usage: ocean session compact [--keep-days N] [--simulate|--apply --before <iso> --plan <fingerprint>] [--json]",
      );
      process.exitCode = 1;
      return;
    }
    const plan = planRetention(store, { keepDays, before });
    if (apply) {
      if (!before || !fingerprint) {
        store.close();
        console.error(
          "ocean session compact --apply requires --before <iso> and --plan <fingerprint> from a prior plan/--simulate run",
        );
        process.exitCode = 1;
        return;
      }
      try {
        const result = await applyRetention(
          store,
          oceanPath(SYSTEM_DIR, "sessions", "sessions.sqlite"),
          plan,
          fingerprint,
        );
        console.log(JSON.stringify({ apply: true, plan, result }, null, 2));
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      } finally {
        store.close();
      }
      return;
    }
    if (simulate) {
      const result = await simulateRetention(
        store,
        oceanPath(SYSTEM_DIR, "sessions", "sessions.sqlite"),
        plan,
        defaultSessionStoreOpener,
      );
      store.close();
      console.log(JSON.stringify({ simulate: true, plan, result }, null, 2));
      return;
    }
    store.close();
    console.log(JSON.stringify({ dryRun: true, plan }, null, 2));
  } else {
    store.close();
    console.error(
      "Usage: ocean session list|show <session-id>|summary <session-id>|events <session-id>|resume <session-id> <prompt>|promote <session-id> [knowledge/<kind>] --approve|doctor [hours] [--apply]|compact [--keep-days N] [--simulate]|compact --apply --before <iso> --plan <fingerprint>",
    );
    process.exitCode = 1;
  }
}

export const commandRegistry: Record<string, CommandHandler> = {
  setup: commandSetup,
  onboard: () => runOnboardCommand(process.argv.slice(3)),
  service: commandService,
  intercept: commandIntercept,
  client: commandClient,
  install: commandInstall,
  auth: commandAuth,
  tasks: commandTasks,
  policy: commandPolicy,
  lifecycle: commandLifecycle,
  observe: commandObserve,
  migrate: commandMigrate,
  layout: commandLayout,
  memory: commandMemory,
  mcp: commandMcp,
  market: commandMarket,
  obsidian: commandObsidian,
  capture: commandCapture,
  handoff: commandHandoff,
  context: commandContext,
  project: commandProject,
  hook: commandHook,
  intent: commandIntent,
  operate: commandOperate,
  idea: commandIdea,
  daily: commandDaily,
  schedule: commandSchedule,
  loop: commandLoop,
  gateway: commandGateway,
  skill: commandSkill,
  catalog: commandCatalog,
  env: commandEnv,
  runtime: commandRuntime,
  update: () => commandUpdateOrRemove("update"),
  remove: () => commandUpdateOrRemove("remove"),
  doctor: commandDoctor,
  repair: commandRepair,
  browser: commandBrowser,
  run: commandRun,
  profiles: () => runProfilesCommand(process.argv.slice(3)),
  session: commandSession,
};
