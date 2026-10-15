import { loadObsidianConnection } from "../../application/obsidian/vault-discovery.js";
import { watchObsidianVault } from "../../application/obsidian/vault-sync.js";

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
  await new Promise<void>((resolve) => {
    let testShutdown: NodeJS.Timeout | undefined;
    const shutdown = (signal: string) => {
      console.log(`Ocean runtime received ${signal}, shutting down.`);
      clearInterval(heartbeat);
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
