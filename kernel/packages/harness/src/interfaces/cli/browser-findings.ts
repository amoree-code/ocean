import { existsSync } from "node:fs";
import { mcpServerFile } from "@ocean/market/adapters/mcp-adapter.js";
import { marketplacePaths } from "@ocean/market/install/default-marketplace.js";
import { chromeDebuggingListening } from "@ocean/market/mcp/chrome-debugging.js";

// Marketplace capabilities that attach to the owner's running Chrome (T-298).
export const BROWSER_CAPABILITIES = [
  "dev.ocean/chrome-devtools",
  "dev.ocean/browser",
];

export type BrowserFinding = {
  code: "BROWSER";
  severity: "OK" | "WARN";
  message: string;
  fixable: false;
};

// `ocean doctor`: once a browser capability is installed, whether Chrome is there to attach to.
// Nothing installed is nothing to report.
export async function browserFindings(
  options: { serversRoot?: string; listening?: () => Promise<boolean> } = {},
): Promise<BrowserFinding[]> {
  const serversRoot = options.serversRoot ?? marketplacePaths().mcpServers;
  const installed = BROWSER_CAPABILITIES.filter((name) =>
    existsSync(mcpServerFile(serversRoot, name)),
  );
  if (!installed.length) return [];
  const finding = (severity: BrowserFinding["severity"], message: string) => [
    { code: "BROWSER" as const, severity, message, fixable: false as const },
  ];
  return (await (options.listening ?? chromeDebuggingListening)())
    ? finding(
        "OK",
        `${installed.join(", ")} installed and Chrome debugging is listening`,
      )
    : finding(
        "WARN",
        `${installed.join(", ")} installed, but Chrome is closed or chrome://inspect/#remote-debugging is off (a sandboxed shell that blocks loopback also sees this)`,
      );
}
