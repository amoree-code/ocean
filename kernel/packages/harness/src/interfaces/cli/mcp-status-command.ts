import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { marketplacePaths } from "@ocean/market/install/default-marketplace.js";
import {
  canSee,
  type GatewayMember,
  gatewayMembers,
  readGatewayAccess,
  sensitivityOf,
} from "@ocean/market/mcp/mcp-gateway.js";
import {
  type InstalledMcpServer,
  launchInputs,
  stdioPackage,
} from "@ocean/market/mcp/mcp-launch.js";
import { keychainStore } from "@ocean/market/security/secrets.js";
import {
  gatewayDefault,
  readGatewayClients,
} from "../../application/clients/clients.js";
import { CLIENT_ADAPTERS } from "../../application/clients/registry.js";
import { oceanVersion } from "../../version.js";
import { gatewayClientFor } from "./mcp-gateway-command.js";

export type ServerStatus = {
  name: string;
  version: string;
  runs: string;
  ready: boolean;
  // Why it does not start, when it does not.
  problem?: string;
  sensitive?: string;
  // Each value it takes and where it comes from; never the value.
  values: { name: string; required: boolean; from: string }[];
  // Gateway-wired clients that see it, and clients that get their own entry for it.
  gatewayClients: string[];
  perServerClients: string[];
  // With --check: what starting it showed.
  check?: { tools: number } | { error: string };
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

async function installedServers(root: string): Promise<InstalledMcpServer[]> {
  let files: string[] = [];
  try {
    files = (await readdir(root)).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  const servers: InstalledMcpServer[] = [];
  for (const file of files.sort())
    try {
      servers.push(JSON.parse(await readFile(path.join(root, file), "utf8")));
    } catch {
      // A broken file shows up in the gateway's own log.
    }
  return servers;
}

async function check(
  member: GatewayMember,
  version: string,
  timeoutMs: number,
): Promise<ServerStatus["check"]> {
  const client = gatewayClientFor(
    member,
    version,
    `ocean mcp status [${member.capability}]`,
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    const tools = await Promise.race([
      client.connect().then(() => client.listTools()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer within ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
    return { tools: tools.length };
  } catch (error) {
    return { error: errorMessage(error) };
  } finally {
    clearTimeout(timer);
    client.close();
  }
}

// `ocean mcp status [--check] [--json]`: every installed MCP server in one view — how it runs,
// whether it can start and why not, the values it needs and where each comes from, and which
// clients reach it. `--check` starts each one and counts its tools.
export async function mcpStatus(
  options: { check?: boolean; timeoutMs?: number } = {},
): Promise<{
  gatewayDefault: string;
  gatewayClients: string[];
  servers: ServerStatus[];
}> {
  const paths = marketplacePaths();
  const store = keychainStore();
  const { members, skipped } = await gatewayMembers({
    serversRoot: paths.mcpServers,
    stateRoot: paths.mcpState,
    firstParty: false,
    secrets: store,
  });
  const access = await readGatewayAccess(paths.gatewayAccess);
  const wired = [...readGatewayClients()].sort();
  const perServer = CLIENT_ADAPTERS.filter(
    (adapter) => adapter.config && !wired.includes(adapter.id),
  ).map((adapter) => adapter.id);
  const version = await oceanVersion();
  const servers: ServerStatus[] = [];
  for (const installed of await installedServers(paths.mcpServers)) {
    const name = installed.capability;
    const member = members.find((each) => each.capability === name);
    const stdio = stdioPackage(installed.server);
    const remote = installed.server.remotes?.[0];
    const status: ServerStatus = {
      name,
      version: installed.version,
      runs: stdio
        ? String(stdio.registryType)
        : remote
          ? `remote ${String(remote.type ?? "streamable-http")}`
          : "?",
      ready: Boolean(member),
      ...(member
        ? {}
        : {
            problem:
              skipped.find((skip) => skip.capability === name)?.reason ??
              "not routed",
          }),
      ...(sensitivityOf(installed)
        ? { sensitive: sensitivityOf(installed) }
        : {}),
      values: launchInputs(installed.server).map((input) => ({
        name: input.name,
        required: input.required,
        from:
          process.env[input.name] !== undefined
            ? "environment"
            : store.get(name, input.name) !== undefined
              ? store.name
              : "missing",
      })),
      gatewayClients: member
        ? wired.filter((client) => canSee(access, client, member))
        : [],
      // `ocean clients apply` gives a per-server entry only to servers with a stdio package.
      perServerClients: stdio ? perServer : [],
    };
    if (options.check && member)
      status.check = await check(member, version, options.timeoutMs ?? 15_000);
    servers.push(status);
  }
  return { gatewayDefault: gatewayDefault(), gatewayClients: wired, servers };
}

export async function runMcpStatusCommand(args: string[]): Promise<void> {
  const report = await mcpStatus({ check: args.includes("--check") });
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(
    `gateway: default ${report.gatewayDefault}; wired: ${report.gatewayClients.join(", ") || "no client"}`,
  );
  if (!report.servers.length)
    console.log(
      "No MCP server installed. Find one with `ocean market search <term>`.",
    );
  for (const server of report.servers) {
    const missing = server.values.filter((value) => value.from === "missing");
    console.log(
      `\n${server.name}@${server.version}  [${server.runs}${server.sensitive ? `, ${server.sensitive}` : ""}]`,
    );
    console.log(
      `  ${server.ready ? "ready" : `not starting: ${server.problem}`}`,
    );
    if (server.values.length)
      console.log(
        `  values: ${server.values.map((value) => `${value.name} (${value.from})`).join(", ")}`,
      );
    if (missing.length)
      console.log(
        `  set with: ${missing.map((value) => `ocean market secret set ${server.name} ${value.name}`).join("; ")}`,
      );
    console.log(
      `  through the gateway: ${server.gatewayClients.join(", ") || "no client"}${server.sensitive && server.ready ? ` (allow with: ocean clients allow <client> ${server.name})` : ""}`,
    );
    if (server.perServerClients.length)
      console.log(
        `  own entry (after ocean clients apply): ${server.perServerClients.join(", ")}`,
      );
    if (server.check)
      console.log(
        `  check: ${"tools" in server.check ? `${server.check.tools} tools` : `failed: ${server.check.error}`}`,
      );
  }
}
