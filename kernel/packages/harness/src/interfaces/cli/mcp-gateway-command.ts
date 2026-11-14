import { MEMORY_INSTRUCTIONS } from "@ocean/core/domain/mcp/memory-contract.js";
import { marketplacePaths } from "@ocean/market/install/default-marketplace.js";
import {
  type GatewayClient,
  type GatewayMember,
  gatewayMembers,
  McpGateway,
  readGatewayAccess,
  serveMcpGateway,
} from "@ocean/market/mcp/mcp-gateway.js";
import { keychainStore } from "@ocean/market/security/secrets.js";
import { McpClient } from "@ocean/services/infrastructure/mcp/mcp-client.js";
import { RemoteMcpClient } from "../../infrastructure/mcp/remote-mcp-client.js";
import { oceanVersion } from "../../version.js";

const OCEAN_SERVER = "dev.ocean/ocean";

// How the gateway (and `ocean mcp status --check`) talks to one member.
export function gatewayClientFor(
  member: GatewayMember,
  version: string,
  stderrLabel = `ocean mcp gateway [${member.capability}]`,
): GatewayClient {
  return member.transport === "remote"
    ? new RemoteMcpClient(member, version)
    : new McpClient({
        command: member.command,
        args: member.args,
        cwd: member.cwd,
        env: member.env,
        inheritEnv: member.inheritEnv,
        stderrLabel,
      });
}

// `ocean mcp gateway`: one stdio MCP endpoint for every registered server. Logs go to stderr,
// which MCP clients keep as the server's log.
// `--installed-only`: leave out Ocean's own servers, for a client wired to them directly.
// `--client <id>`: the client this process serves, for the access rules.
export async function runMcpGatewayCommand(args: string[] = []): Promise<void> {
  const log = (line: string) => console.error(`ocean mcp gateway: ${line}`);
  const paths = marketplacePaths();
  const firstParty = !args.includes("--installed-only");
  const { members, skipped } = await gatewayMembers({
    serversRoot: paths.mcpServers,
    stateRoot: paths.mcpState,
    firstParty,
    secrets: keychainStore(),
  });
  for (const skip of skipped)
    log(`${skip.capability} not routed: ${skip.reason}`);
  const version = await oceanVersion();
  const gateway = new McpGateway(members, {
    client: (member) => gatewayClientFor(member, version),
    version,
    log,
    // When Ocean's own server sits behind the gateway and this client may see it, the client
    // gets Ocean's memory contract in `initialize`, as on a direct connection (T-313).
    ...(firstParty
      ? { instructions: MEMORY_INSTRUCTIONS, instructionsMember: OCEAN_SERVER }
      : {}),
    access: await readGatewayAccess(paths.gatewayAccess),
    clientId: args.includes("--client")
      ? args[args.indexOf("--client") + 1]
      : undefined,
  });
  await serveMcpGateway(gateway);
}
