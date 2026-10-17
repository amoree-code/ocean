import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { mcpServerFile } from "../adapters/mcp-adapter.js";
import { type InstalledMcpServer, planMcpLaunch } from "./mcp-launch.js";

// The one way an installed MCP server is started: planned against its declared permissions,
// then run inside the sandbox with stdio passed through, so a client can point at
// `ocean market exec <name>` as its stdio command.
export async function runInstalledMcp(
  name: string,
  options: {
    serversRoot: string;
    stateRoot: string;
    allowUnsandboxed?: boolean;
  },
): Promise<number> {
  let installed: InstalledMcpServer;
  try {
    installed = JSON.parse(
      await readFile(mcpServerFile(options.serversRoot, name), "utf8"),
    );
  } catch {
    throw new Error(`${name} is not an installed MCP server`);
  }
  const stateDir = path.join(
    options.stateRoot,
    path.basename(mcpServerFile(options.serversRoot, name), ".json"),
  );
  await mkdir(stateDir, { recursive: true });
  const launch = planMcpLaunch(installed, {
    stateDir,
    allowUnsandboxed: options.allowUnsandboxed,
  });
  if (launch.transport === "remote")
    throw new Error(
      `${name} is a remote server (${launch.type} ${launch.url}); connect the client to it directly`,
    );
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: "inherit",
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
