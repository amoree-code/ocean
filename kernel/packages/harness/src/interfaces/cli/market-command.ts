import path from "node:path";
import {
  createDefaultMarketplace,
  marketplacePaths,
} from "@ocean/market/install/default-marketplace.js";
import { addOwnMcpServer } from "@ocean/market/install/own-server.js";
import { runInstalledMcp } from "@ocean/market/mcp/mcp-runner.js";
import { oceanVersion } from "../../version.js";

const usage =
  "Usage: ocean market list|install <name> [--version <v>]|update <name>|uninstall <name>|exec <name>|add <server.json> [--index <file>]... [--yes] [--accept-flagged]";

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
  if (action === "add" && name) {
    console.log(
      JSON.stringify(
        await addOwnMcpServer({
          serverFile: path.resolve(name),
          indexFile: marketplacePaths().index,
          oceanVersion: await oceanVersion(),
          marketplace: () => createMarketplace([]),
        }),
        null,
        2,
      ),
    );
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
  if (action === "install")
    console.log(
      JSON.stringify(
        await marketplace.install(name, flagValues(args, "--version")[0]),
        null,
        2,
      ),
    );
  else if (action === "update")
    console.log(JSON.stringify(await marketplace.update(name), null, 2));
  else {
    await marketplace.uninstall(name);
    console.log(JSON.stringify({ name, status: "uninstalled" }, null, 2));
  }
}
