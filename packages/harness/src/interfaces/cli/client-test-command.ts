import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildOceanBootstrap } from "@ocean/context/context/resource-injection.js";
import { enginePath, oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { resolveProject } from "@ocean/core/shared/project-resolution.js";
import { claudeNativeHookStatus } from "../../application/hooks/session-start-hook.js";
import { openSessionStore } from "../../infrastructure/persistence/session-store.js";
import {
  findProvider,
  loadProviderRegistry,
  resolveOriginalExecutable,
} from "../../infrastructure/providers/provider-registry.js";
import {
  providerWrapperName,
  providerWrapperPath,
  shimDirectory,
} from "../../infrastructure/wrappers/wrapper-manager.js";

export async function runClientTestCommand(
  providerName: string,
  json = false,
): Promise<void> {
  const cwd = path.resolve(process.cwd());
  const project = await resolveProject(cwd);
  const bootstrap = buildOceanBootstrap(project);
  const providers = providerName
    ? [findProvider(providerName)]
    : loadProviderRegistry();
  const store = await openSessionStore();
  const reports = await Promise.all(
    providers.map((provider) =>
      buildReport(provider, cwd, project, bootstrap, store),
    ),
  );
  store.close();

  if (json) {
    console.log(JSON.stringify(providerName ? reports[0] : reports, null, 2));
    return;
  }
  for (const report of reports) printReport(report);
}

async function buildReport(
  provider: ReturnType<typeof findProvider>,
  cwd: string,
  project: Awaited<ReturnType<typeof resolveProject>>,
  bootstrap: ReturnType<typeof buildOceanBootstrap>,
  store: Awaited<ReturnType<typeof openSessionStore>>,
) {
  let executable: string | null = null;
  try {
    executable = resolveOriginalExecutable(provider.command);
  } catch {
    /* Report missing provider below. */
  }
  const latest =
    store.list().find((session) => session.provider === provider.id) ?? null;
  const events = latest ? store.listEvents(latest.sessionId) : [];
  const entry = events.find((event) => event.type === "session_entry_contract");
  const manifest = events.find((event) => event.type === "ocean_bootstrap");
  const entryBoundary =
    provider.id === "claude"
      ? await claudeEntryBoundaryStatus()
      : {
          kind: "wrapper-only",
          detail: `No native hook is wired for this provider. A plain ${provider.command} runs natively; ${providerWrapperName(provider.command)} routes it through Ocean (ocean intercept --client).`,
        };
  return {
    provider: provider.id,
    routing: {
      cwd,
      command: provider.command,
      shim: providerWrapperPath(provider.command),
      shimDirectory: shimDirectory(),
      nativeExecutable: executable,
      oceanEngine: enginePath("dist", "main.js"),
    },
    project,
    ocean: {
      root: oceanPath(),
      bootstrapBytes: bootstrap.manifest.bytes,
      bootstrapTransport: bootstrap.manifest.transport,
      sessionStore: oceanPath(SYSTEM_DIR, "sessions", "sessions.sqlite"),
      runtimeLogs: oceanPath(SYSTEM_DIR, "runtime", "logs", "runtime.jsonl"),
      sessionSummaries: oceanPath(SYSTEM_DIR, "sessions", "summaries"),
    },
    entryBoundary,
    // The bootstrap is always delivered as an environment variable when launched through the
    // Ocean shim; whether the provider itself reads it natively (a hook, a config convention)
    // is unverified until that provider's own consumption is tested — never claimed PROVEN here.
    transport:
      "NOT PROVEN: bootstrap-env (delivered as OCEAN_BOOTSTRAP; native provider consumption unverified)",
    providerOwnedPaths:
      provider.id === "claude"
        ? [
            path.join(os.homedir(), ".claude"),
            path.join(os.homedir(), ".claude", "CLAUDE.md"),
            path.join(cwd, "CLAUDE.md"),
            path.join(cwd, ".claude", "CLAUDE.md"),
          ].map((file) => ({ path: file, exists: existsSync(file) }))
        : [
            {
              path: "provider-managed (not controlled by Ocean)",
              exists: null,
            },
          ],
    latestSession: latest
      ? {
          sessionId: latest.sessionId,
          status: latest.status,
          entryContract: entry ? JSON.parse(entry.data) : null,
          bootstrapManifest: manifest ? JSON.parse(manifest.data) : null,
        }
      : null,
  };
}

async function claudeEntryBoundaryStatus(): Promise<{
  kind: string;
  detail: string;
}> {
  const hook = await claudeNativeHookStatus();
  if (hook.registered) {
    return {
      kind: "native-hook-registered",
      detail: `SessionStart hook is registered in ${hook.settingsPath} and points at ${hook.scriptPath}. Its actual invocation by a live Claude Code session is still unverified here — this only proves registration.`,
    };
  }
  if (hook.scriptInstalled) {
    return {
      kind: "native-hook-available-not-registered",
      detail: `Hook script exists at ${hook.scriptPath} but hooks.SessionStart in ${hook.settingsPath} does not reference it. Until it does, only ${providerWrapperName("claude")} routes Claude through Ocean.`,
    };
  }
  return {
    kind: "wrapper-only",
    detail: `No native SessionStart hook script found. Only ${providerWrapperName("claude")} routes Claude through Ocean (ocean intercept --client claude).`,
  };
}

function printReport(report: Awaited<ReturnType<typeof buildReport>>): void {
  console.log(`Ocean client test: ${report.provider}`);
  console.log(`cwd: ${report.routing.cwd}`);
  console.log(`shim: ${report.routing.shim}`);
  console.log(
    `native executable: ${report.routing.nativeExecutable ?? "NOT FOUND outside Ocean shims"}`,
  );
  console.log(`Ocean engine: ${report.routing.oceanEngine}`);
  console.log(
    `project: ${report.project.status}${report.project.status === "bound" ? ` (${report.project.projectId}, confidence: ${report.project.confidence})` : ""}`,
  );
  console.log(
    `entry boundary: ${report.entryBoundary.kind} — ${report.entryBoundary.detail}`,
  );
  console.log(`Ocean bootstrap bytes: ${report.ocean.bootstrapBytes}`);
  console.log(`Ocean saves sessions: ${report.ocean.sessionStore}`);
  console.log(`Ocean saves runtime logs: ${report.ocean.runtimeLogs}`);
  console.log(`Ocean saves summaries: ${report.ocean.sessionSummaries}`);
  console.log(`transport: ${report.transport}`);
  console.log("Provider-owned paths:");
  for (const file of report.providerOwnedPaths)
    console.log(
      `- ${file.exists === null ? "not controlled" : file.exists ? "present" : "absent"}: ${file.path}`,
    );
  if (report.latestSession)
    console.log(
      `latest session: ${report.latestSession.sessionId} [${report.latestSession.status}] — inspect with: ocean session events ${report.latestSession.sessionId}`,
    );
  else console.log("latest session: none");
}
