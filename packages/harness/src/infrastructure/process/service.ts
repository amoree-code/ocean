import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { reindexBrain } from "@ocean/brain/brain/brain-reindex.js";
import { brainIndexState } from "@ocean/brain/brain/brain-service.js";
import { brainIndexPort } from "@ocean/brain/infrastructure/brain/brain-index.js";
import type { EmbedderPort } from "@ocean/core/domain/ports/embedder-port.js";
import { loadObsidianConnection } from "@ocean/services/obsidian/vault-discovery.js";
import { watchObsidianVault } from "@ocean/services/obsidian/vault-sync.js";
import { refreshClaudeProjects } from "../../application/pull/server-capture.js";
import { createOllamaEmbedder } from "../providers/ollama-embedder.js";

const HOUR_MS = 60 * 60 * 1000;
const REINDEX_CHECK_MS = 2 * 60 * 1000;
const CLAUDE_PROJECTS_MS = 15 * 60 * 1000;

let reindexing = false;

// Keeps the brain index current (T-307): a record written over MCP, an approval or a hand edit is
// searchable within minutes, without `ocean memory reindex`. The build goes to a temp file renamed
// into place, so a search never reads half an index. Vectors when the local embedder answers;
// without one, an index that has vectors waits for it rather than losing them, and one without is
// rebuilt as full text. OCEAN_NO_AUTO_REINDEX=1 turns it off.
export async function reindexWhenStale(
  options: {
    root?: string;
    embedder?: () => Promise<EmbedderPort | null>;
  } = {},
): Promise<"rebuilt" | "fresh" | "waiting" | "busy" | "off"> {
  if (process.env.OCEAN_NO_AUTO_REINDEX === "1") return "off";
  if (reindexing) return "busy";
  reindexing = true;
  try {
    const state = await brainIndexState({
      root: options.root,
      indexPort: brainIndexPort,
    });
    if (!state.stale) return "fresh";
    const embedder = await (
      options.embedder ?? (() => createOllamaEmbedder())
    )().catch(() => null);
    if (!embedder && state.hasVectors) return "waiting";
    await reindexBrain({
      root: options.root,
      embedder,
      indexPort: brainIndexPort,
    });
    return "rebuilt";
  } finally {
    reindexing = false;
  }
}

// The owner's Claude project names, so a conversation in a new Claude project can register it
// (T-307). Reading the caches takes tens of seconds, so it runs here, never in a tool call.
function startClaudeProjectsRefresh(): void {
  if (process.env.OCEAN_NO_PULL_ON_START === "1") return;
  refreshClaudeProjects(os.homedir()).catch((error) => {
    console.error(
      `Claude project names not refreshed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

function startAutoReindex(): void {
  reindexWhenStale().catch((error) => {
    console.error(
      `brain reindex failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

// The daily `ocean pull --yes` (T-305) in a detached child; it returns at once when the last pull
// is under a day old. Session starts run it, and so does the always-on service, so a user who only
// opens Claude Desktop is pulled too. OCEAN_NO_PULL_ON_START=1 turns both off.
export function startBackgroundPull(): void {
  if (process.env.OCEAN_NO_PULL_ON_START === "1") return;
  try {
    spawn(process.execPath, [process.argv[1], "pull", "--yes", "--daily"], {
      detached: true,
      stdio: "ignore",
    })
      .on("error", () => {})
      .unref();
  } catch {
    // no pull this time; the next try runs it
  }
}

export type ServiceRestart =
  | "restarted"
  | "not-installed"
  | "next-login"
  | { failed: string };

type Run = (command: string, args: string[]) => Promise<unknown>;

const runCommand: Run = (command, args) => promisify(execFile)(command, args);

// A running service keeps the engine it started with, whatever `current` or its start file now
// say (T-305), so a new release or a repointed start file restarts it. launchd and systemd re-read
// the file on reload; the Windows startup script has no manager and takes effect at next login.
// Never throws: it runs inside session starts and releases, which must not fail on it.
export async function restartService(
  options: {
    home?: string;
    platform?: NodeJS.Platform;
    run?: Run;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<ServiceRestart> {
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCommand;
  const wait =
    options.wait ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  try {
    if (platform === "darwin") {
      const plist = path.join(
        home,
        "Library",
        "LaunchAgents",
        "com.ocean.runtime.plist",
      );
      if (!existsSync(plist)) return "not-installed";
      const domain = `gui/${process.getuid?.() ?? ""}`;
      const label = `${domain}/com.ocean.runtime`;
      await run("launchctl", ["bootout", label]).catch(() => {});
      // bootout returns before launchd has removed the job, and a bootstrap while it is still
      // there fails ("Bootstrap failed: 5: Input/output error") and leaves the service stopped
      // (T-307): wait until `print` no longer finds it, up to 5 s.
      for (let poll = 0; poll < 20; poll += 1) {
        const loaded = await run("launchctl", ["print", label]).then(
          () => true,
          () => false,
        );
        if (!loaded) break;
        await wait(250);
      }
      // The service is stopped and its file already current, so nothing else retries it: three
      // tries a second apart, then the error names the command that starts it again.
      let failure: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt) await wait(1000);
        try {
          await run("launchctl", ["bootstrap", domain, plist]);
          return "restarted";
        } catch (error) {
          failure = error;
        }
      }
      throw new Error(
        `${failure instanceof Error ? failure.message : String(failure)} — the service is stopped; start it with: launchctl bootstrap ${domain} ${plist}`,
      );
    }
    if (platform === "linux") {
      const unit = path.join(
        home,
        ".config",
        "systemd",
        "user",
        "ocean.service",
      );
      if (!existsSync(unit)) return "not-installed";
      await run("systemctl", ["--user", "daemon-reload"]);
      await run("systemctl", ["--user", "try-restart", "ocean.service"]);
      return "restarted";
    }
    const startup = path.join(
      process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
      "ocean.cmd",
    );
    return platform === "win32" && existsSync(startup)
      ? "next-login"
      : "not-installed";
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) };
  }
}

export async function runService(shutdownAfterMs?: number): Promise<void> {
  const controller = new AbortController();
  let watcher: Promise<void> | undefined;
  try {
    const connection = await loadObsidianConnection();
    watcher = watchObsidianVault(
      connection,
      undefined,
      controller.signal,
    ).catch((error) => {
      console.error(
        `Obsidian watcher stopped: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    console.log(`Obsidian watcher enabled: ${connection.vaultPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(
        `Obsidian watcher unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const heartbeat = setInterval(() => undefined, 60_000);
  startBackgroundPull();
  const dailyPull = setInterval(startBackgroundPull, HOUR_MS);
  startAutoReindex();
  const autoReindex = setInterval(startAutoReindex, REINDEX_CHECK_MS);
  startClaudeProjectsRefresh();
  const claudeProjects = setInterval(
    startClaudeProjectsRefresh,
    CLAUDE_PROJECTS_MS,
  );
  await new Promise<void>((resolve) => {
    let testShutdown: NodeJS.Timeout | undefined;
    const shutdown = (signal: string) => {
      console.log(`Ocean runtime received ${signal}, shutting down.`);
      clearInterval(heartbeat);
      clearInterval(dailyPull);
      clearInterval(autoReindex);
      clearInterval(claudeProjects);
      controller.abort();
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      process.off("message", onMessage);
      if (testShutdown) clearTimeout(testShutdown);
      resolve();
    };
    const onMessage = (message: unknown): void => {
      if (message === "shutdown") shutdown("IPC");
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("message", onMessage);
    // Only now is a SIGTERM handled gracefully; announcing earlier lets a signal that
    // arrives during startup kill the process before it can shut down cleanly.
    console.log("Ocean runtime is running.");
    if (shutdownAfterMs !== undefined)
      testShutdown = setTimeout(() => shutdown("timer"), shutdownAfterMs);
  });
  await watcher;
  console.log("Ocean runtime stopped.");
}
