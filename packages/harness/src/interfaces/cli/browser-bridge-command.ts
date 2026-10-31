import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { liveEngineEntry, oceanRoot } from "@ocean/core/shared/paths.js";
import {
  BrowserBridge,
  browserBridgeHealth,
  browserBridgePort,
  serveBrowserBridge,
} from "@ocean/market/mcp/browser-bridge.js";
import { McpClient } from "@ocean/services/infrastructure/mcp/mcp-client.js";
import { oceanVersion } from "../../version.js";

const LABEL = "com.ocean.browser-bridge";
const run = promisify(execFile);

// `ocean mcp browser-bridge`: the one loopback MCP endpoint in front of the owner's Chrome. Logs
// go to stderr and never carry page content.
export async function runBrowserBridgeCommand(): Promise<void> {
  const log = (line: string) => console.error(`ocean browser bridge: ${line}`);
  const bridge = new BrowserBridge({
    client: (member) =>
      new McpClient({
        command: member.command,
        args: member.args,
        cwd: member.cwd,
        env: member.env,
        inheritEnv: member.inheritEnv,
      }),
    version: await oceanVersion(),
    log,
  });
  const port = browserBridgePort();
  const server = await serveBrowserBridge(bridge, port, log);
  log(`listening on 127.0.0.1:${port}`);
  const stop = () => {
    bridge.close();
    server.close();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

function plistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? ""}`;
}

async function installService(): Promise<void> {
  const logs = path.join(os.homedir(), "Library", "Logs");
  const file = plistPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${process.execPath}</string><string>${liveEngineEntry()}</string><string>mcp</string><string>browser-bridge</string></array>
<key>WorkingDirectory</key><string>${oceanRoot()}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardErrorPath</key><string>${path.join(logs, `${LABEL}.log`)}</string>
</dict></plist>
`,
  );
  await run("launchctl", ["bootout", `${launchdDomain()}/${LABEL}`]).catch(
    () => {},
  );
  await run("launchctl", ["bootstrap", launchdDomain(), file]);
  console.log(`installed ${LABEL}: ${file}`);
}

async function uninstallService(): Promise<void> {
  await run("launchctl", ["bootout", `${launchdDomain()}/${LABEL}`]).catch(
    () => {},
  );
  await rm(plistPath(), { force: true });
  console.log(`removed ${LABEL}`);
}

export async function runBrowserServiceCommand(action: string): Promise<void> {
  if (process.platform !== "darwin") {
    console.error(
      "ocean mcp browser-service supports macOS only; run `ocean mcp browser-bridge` under your own service manager.",
    );
    process.exitCode = 1;
  } else if (action === "install") await installService();
  else if (action === "uninstall") await uninstallService();
  else {
    console.error("Usage: ocean mcp browser-service install|uninstall");
    process.exitCode = 1;
  }
}

export async function browserBridgeFindings(): Promise<
  {
    code: string;
    severity: "OK" | "WARN";
    message: string;
    fixable: boolean;
  }[]
> {
  const health = await browserBridgeHealth();
  const finding = (severity: "OK" | "WARN", message: string) => [
    { code: "BROWSER_BRIDGE", severity, message, fixable: false },
  ];
  if (!health)
    return finding(
      "WARN",
      "browser bridge is not reachable; start it with `ocean mcp browser-service install` (a sandboxed shell cannot reach loopback)",
    );
  return health.chromeDebuggingListening
    ? finding("OK", "browser bridge is up and Chrome debugging is listening")
    : finding(
        "WARN",
        "browser bridge is up but Chrome is closed or chrome://inspect/#remote-debugging is off",
      );
}
