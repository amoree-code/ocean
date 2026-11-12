import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// The loopback browser bridge (T-298, v1.1–v1.2) was replaced by the marketplace capability
// `dev.ocean/chrome-devtools`, which every client starts over stdio. Only the cleanup of its
// launchd service is left, for machines that installed it.
const LABEL = "com.ocean.browser-bridge";
const run = promisify(execFile);

export async function runBrowserServiceCommand(action: string): Promise<void> {
  if (action !== "uninstall") {
    console.error(
      "Usage: ocean mcp browser-service uninstall — the browser bridge is retired; install dev.ocean/chrome-devtools with `ocean market install` and run `ocean clients apply`.",
    );
    process.exitCode = 1;
    return;
  }
  if (process.platform !== "darwin") {
    console.log("nothing to remove: the browser service was macOS only");
    return;
  }
  await run("launchctl", [
    "bootout",
    `gui/${process.getuid?.() ?? ""}/${LABEL}`,
  ]).catch(() => {});
  await rm(
    path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`),
    { force: true },
  );
  console.log(`removed ${LABEL}`);
}
