import { spawn } from "node:child_process";
import { loadObsidianConnection } from "@ocean/services/obsidian/vault-discovery.js";
import { watchObsidianVault } from "@ocean/services/obsidian/vault-sync.js";

const HOUR_MS = 60 * 60 * 1000;

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
  await new Promise<void>((resolve) => {
    let testShutdown: NodeJS.Timeout | undefined;
    const shutdown = (signal: string) => {
      console.log(`Ocean runtime received ${signal}, shutting down.`);
      clearInterval(heartbeat);
      clearInterval(dailyPull);
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
