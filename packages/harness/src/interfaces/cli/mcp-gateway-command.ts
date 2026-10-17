import { marketplacePaths } from "@ocean/market/install/default-marketplace.js";
import {
  gatewayMembers,
  McpGateway,
  serveMcpGateway,
} from "@ocean/market/mcp/mcp-gateway.js";
import { McpClient } from "@ocean/services/infrastructure/mcp/mcp-client.js";
import { oceanVersion } from "../../version.js";

// `ocean mcp gateway`: one stdio MCP endpoint for every registered server. Logs go to stderr,
// which MCP clients keep as the server's log.
export async function runMcpGatewayCommand(): Promise<void> {
  const log = (line: string) => console.error(`ocean mcp gateway: ${line}`);
  const paths = marketplacePaths();
  const { members, skipped } = await gatewayMembers({
    serversRoot: paths.mcpServers,
    stateRoot: paths.mcpState,
  });
  for (const skip of skipped)
    log(`${skip.capability} not routed: ${skip.reason}`);
  const gateway = new McpGateway(members, {
    client: (member) =>
      new McpClient({
        command: member.command,
        args: member.args,
        cwd: member.cwd,
        env: member.env,
        inheritEnv: member.inheritEnv,
        stderrLabel: `ocean mcp gateway [${member.capability}]`,
      }),
    version: await oceanVersion(),
    log,
  });
  await serveMcpGateway(gateway);
}
