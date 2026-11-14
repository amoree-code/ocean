import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { mcpServerFile } from "@ocean/market/adapters/mcp-adapter.js";
import {
  createDefaultMarketplace,
  marketplacePaths,
} from "@ocean/market/install/default-marketplace.js";
import { addOwnMcpServer } from "@ocean/market/install/own-server.js";
import { sensitivityOf } from "@ocean/market/mcp/mcp-gateway.js";
import {
  type InstalledMcpServer,
  launchInputs,
} from "@ocean/market/mcp/mcp-launch.js";
import { runInstalledMcp } from "@ocean/market/mcp/mcp-runner.js";
import {
  fetchRegistryServer,
  searchRegistry,
} from "@ocean/market/registry/official-registry.js";
import { keychainStore } from "@ocean/market/security/secrets.js";
import { oceanVersion } from "../../version.js";

const usage =
  "Usage: ocean market list|search <term>|add <server.json|registry name> [--version <v>]|install <name> [--version <v>]|update <name>|uninstall <name>|exec <name>|secret list|set|remove <name> [<value name>] [--index <file>]... [--yes] [--accept-flagged]";

function installedServer(name: string): InstalledMcpServer {
  try {
    return JSON.parse(
      readFileSync(mcpServerFile(marketplacePaths().mcpServers, name), "utf8"),
    );
  } catch {
    throw new Error(`${name} is not an installed MCP server`);
  }
}

// What each value an installed server needs is set from, never the value itself.
function inputStates(name: string) {
  const installed = installedServer(name);
  const store = keychainStore();
  return launchInputs(installed.server).map((input) => ({
    ...input,
    from:
      process.env[input.name] !== undefined
        ? "environment"
        : store.get(installed.capability, input.name) !== undefined
          ? store.name
          : "missing",
  }));
}

// A server the gateway hides by default says so at install, with the command that shows it.
function printVisibility(name: string): void {
  let installed: InstalledMcpServer;
  try {
    installed = installedServer(name);
  } catch {
    return;
  }
  const reason = sensitivityOf(installed);
  if (reason)
    console.error(
      `${name} ${reason}, so gateway-wired clients do not see it until allowed: ocean clients allow <client> ${name}`,
    );
}

// After an add: which values still have to be set before the server starts, and how.
function printInputs(name: string): void {
  for (const input of inputStates(name))
    if (input.from === "missing")
      console.error(
        `${name} ${input.required ? "needs" : "can take"} ${input.name}${input.description ? ` (${input.description})` : ""}: ocean market secret set ${name} ${input.name}`,
      );
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY)
    console.error("Paste the value, then press Enter and Ctrl-D:");
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text.replace(/\r?\n$/, "");
}

// `ocean market secret list|set|remove <name> [<value name>]`: the value is read from stdin, so
// it never appears in shell history or a process list, and is never printed.
async function runSecretCommand(args: string[]): Promise<void> {
  const [verb, name, input] = args.filter((arg) => !arg.startsWith("--"));
  if (!name || !["list", "set", "remove"].includes(verb))
    throw new Error(
      "Usage: ocean market secret list <name> | set <name> <value name> | remove <name> <value name>",
    );
  if (verb === "list") {
    console.log(JSON.stringify(inputStates(name), null, 2));
    return;
  }
  const installed = installedServer(name);
  const known = launchInputs(installed.server).map((each) => each.name);
  if (!input || !known.includes(input))
    throw new Error(
      `${name} takes ${known.length ? known.join(", ") : "no values"}`,
    );
  const store = keychainStore();
  if (verb === "set") {
    const value = await readStdin();
    if (!value) throw new Error("no value given on stdin");
    store.set(installed.capability, input, value);
    console.log(JSON.stringify({ name, set: input, in: store.name }));
  } else
    console.log(
      JSON.stringify({
        name,
        removed: input,
        found: store.remove(installed.capability, input),
      }),
    );
}

function flagValues(args: string[], flag: string): string[] {
  return args.flatMap((arg, index) =>
    arg === flag && args[index + 1] ? [args[index + 1]] : [],
  );
}

export async function runMarketCommand(
  action: string,
  args: string[],
): Promise<void> {
  const approved = args.includes("--yes");
  const createMarketplace = (indexFiles: string[]) =>
    createDefaultMarketplace({
      indexFiles,
      acceptFlagged: args.includes("--accept-flagged"),
      // Non-interactive: permissions are granted only by an explicit --yes, and are always shown.
      consent: async (manifest) => {
        console.error(
          `${manifest.name}@${manifest.version} requests permissions: ${JSON.stringify(manifest.permissions)}`,
        );
        if (!approved) console.error("Re-run with --yes to grant them.");
        return approved;
      },
    });
  const marketplace = createMarketplace(flagValues(args, "--index"));
  const name = args.find(
    (arg, index) =>
      !arg.startsWith("--") &&
      !["--index", "--version"].includes(args[index - 1]),
  );
  if (action === "list") {
    const installed = await marketplace.installed();
    console.log(
      JSON.stringify(
        Object.entries(installed).map(([id, entry]) => ({
          name: id,
          kind: entry.manifest.kind,
          version: entry.manifest.version,
          sha256: entry.manifest.integrity.sha256,
          installedAt: entry.installedAt,
        })),
        null,
        2,
      ),
    );
    return;
  }
  if (action === "search" && name) {
    const hits = await searchRegistry(
      args.filter((arg) => !arg.startsWith("--")).join(" "),
    );
    if (args.includes("--json")) console.log(JSON.stringify(hits, null, 2));
    else if (!hits.length)
      console.log("No server in the MCP registry matches.");
    else
      for (const hit of hits)
        console.log(
          `${hit.name}@${hit.version}  [${hit.runs}${hit.status === "active" ? "" : `, ${hit.status}`}${hit.needs.length ? `, needs ${hit.needs.join(", ")}` : ""}]\n    ${hit.description}`,
        );
    return;
  }
  if (action === "add" && name) {
    // A path to a server.json, or a name in the MCP registry.
    const file = path.resolve(name);
    let server: unknown;
    let from: string;
    if (name.endsWith(".json") || existsSync(file)) {
      server = JSON.parse(await readFile(file, "utf8"));
      from = path.basename(file);
    } else {
      const found = await fetchRegistryServer(name, {
        version: flagValues(args, "--version")[0],
      });
      if (found.status !== "active")
        console.error(`${name} is ${found.status} in the MCP registry.`);
      server = found.server;
      from = "the MCP registry";
    }
    const result = await addOwnMcpServer({
      server,
      from,
      indexFile: marketplacePaths().index,
      oceanVersion: await oceanVersion(),
      marketplace: () => createMarketplace([]),
    });
    console.log(JSON.stringify(result, null, 2));
    printInputs(result.name);
    printVisibility(result.name);
    return;
  }
  if (action === "secret") {
    await runSecretCommand(args);
    return;
  }
  if (action === "exec" && name) {
    const paths = marketplacePaths();
    process.exitCode = await runInstalledMcp(name, {
      serversRoot: paths.mcpServers,
      stateRoot: paths.mcpState,
    });
    return;
  }
  if (!name || !["install", "update", "uninstall"].includes(action))
    throw new Error(usage);
  if (action === "install") {
    const result = await marketplace.install(
      name,
      flagValues(args, "--version")[0],
    );
    console.log(JSON.stringify(result, null, 2));
    printVisibility(result.name);
  } else if (action === "update")
    console.log(JSON.stringify(await marketplace.update(name), null, 2));
  else {
    await marketplace.uninstall(name);
    console.log(JSON.stringify({ name, status: "uninstalled" }, null, 2));
  }
}
