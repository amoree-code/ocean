import { marketplacePaths } from "@ocean/market/install/default-marketplace.js";
import {
  gatewayMembers,
  McpGateway,
  readGatewayAccess,
  serveMcpGateway,
} from "@ocean/market/mcp/mcp-gateway.js";
import { McpClient } from "@ocean/services/infrastructure/mcp/mcp-client.js";
import { RemoteMcpClient } from "../../infrastructure/mcp/remote-mcp-client.js";
import { oceanVersion } from "../../version.js";

// `ocean mcp gateway`: one stdio MCP endpoint for every registered server. Logs go to stderr,
// which MCP clients keep as the server's log.
// `--installed-only`: leave out Ocean's own servers, for a client wired to them directly.
export async function runMcpGatewayCommand(args: string[] = []): Promise<void> {
  const log = (line: string) => console.error(`ocean mcp gateway: ${line}`);
  const paths = marketplacePaths();
  const { members, skipped } = await gatewayMembers({
    serversRoot: paths.mcpServers,
    stateRoot: paths.mcpState,
    firstParty: !args.includes("--installed-only"),
  });
  for (const skip of skipped)
    log(`${skip.capability} not routed: ${skip.reason}`);
  const version = await oceanVersion();
  const gateway = new McpGateway(members, {
    client: (member) =>
      member.transport === "remote"
        ? new RemoteMcpClient(member, version)
        : new McpClient({
            command: member.command,
            args: member.args,
            cwd: member.cwd,
            env: member.env,
            inheritEnv: member.inheritEnv,
            stderrLabel: `ocean mcp gateway [${member.capability}]`,
          }),
    version,
    log,
    access: await readGatewayAccess(paths.gatewayAccess),
  });
  await serveMcpGateway(gateway);
}
