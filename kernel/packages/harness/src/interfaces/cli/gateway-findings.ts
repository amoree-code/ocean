import { marketplacePaths } from "@ocean/market/install/default-marketplace.js";
import { readGatewayAccess } from "@ocean/market/mcp/mcp-gateway.js";
import { readGatewayClients } from "../../application/clients/clients.js";

export type GatewayFinding = {
  code: "GATEWAY";
  severity: "OK" | "FAIL";
  message: string;
  fixable: false;
};

// `ocean doctor` (T-309): which clients reach installed servers through the one gateway entry,
// and whether the access file the gateway reads at start is valid; an invalid one stops the
// gateway, and with it every installed server in those clients. Nothing set up is nothing to
// report.
export async function gatewayFindings(
  options: { accessFile?: string; clients?: Set<string> } = {},
): Promise<GatewayFinding[]> {
  const accessFile = options.accessFile ?? marketplacePaths().gatewayAccess;
  const clients = [...(options.clients ?? readGatewayClients())].sort();
  const finding = (severity: GatewayFinding["severity"], message: string) => ({
    code: "GATEWAY" as const,
    severity,
    message,
    fixable: false as const,
  });
  let rules: string[];
  try {
    rules = Object.keys((await readGatewayAccess(accessFile)).clients);
  } catch (error) {
    return [
      finding(
        "FAIL",
        `${error instanceof Error ? error.message : String(error)}; the gateway will not start until it is fixed`,
      ),
    ];
  }
  if (!clients.length && !rules.length) return [];
  return [
    finding(
      "OK",
      `${clients.length ? `wired through ocean-gateway: ${clients.join(", ")}` : "no client wired through ocean-gateway"}; access rules for ${rules.length ? rules.join(", ") : "no client (the default hides servers that write files or drive a browser)"}. Undo with \`ocean clients gateway <id> off\` and \`ocean clients apply\``,
    ),
  ];
}
