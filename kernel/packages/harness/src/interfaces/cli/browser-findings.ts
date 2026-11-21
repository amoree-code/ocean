import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { mcpServerFile } from "@ocean/market/adapters/mcp-adapter.js";
import { marketplacePaths } from "@ocean/market/install/default-marketplace.js";
import {
  BROWSER_CAPABILITY,
  BROWSER_PROFILE_VARIABLE,
  browserLabel,
  chromeDebuggingListening,
  listeningBrowsers,
  selectedBrowserProfile,
} from "@ocean/market/mcp/chrome-debugging.js";
import { keychainStore } from "@ocean/market/security/secrets.js";

// Marketplace capabilities that attach to the owner's running browser (T-298).
export const BROWSER_CAPABILITIES = [
  "dev.ocean/chrome-devtools",
  "dev.ocean/browser",
];

// chrome-devtools-mcp attaches with --autoConnect, which needs the inspect page's remote
// debugging switch: Chromium 144 or later.
export const MIN_AUTO_CONNECT_MAJOR = 144;

// The Chromium major the browser last ran, from the `Last Version` file it keeps in its profile
// root (Brave writes the Chromium version there too). No DevTools connection, so no prompt.
export function browserMajorVersion(root: string): number | undefined {
  try {
    const major = Number.parseInt(
      readFileSync(path.join(root, "Last Version"), "utf8"),
      10,
    );
    return Number.isInteger(major) ? major : undefined;
  } catch {
    return undefined;
  }
}

export type BrowserFinding = {
  code: "BROWSER";
  severity: "OK" | "WARN";
  message: string;
  fixable: false;
};

// `ocean doctor`: once a browser capability is installed, whether the chosen browser is there
// to attach to — and, when it is not, whether another Chromium browser is. Nothing installed is
// nothing to report.
export async function browserFindings(
  options: {
    serversRoot?: string;
    profileRoot?: string;
    listening?: (portFile: string) => Promise<boolean>;
    major?: (root: string) => number | undefined;
  } = {},
): Promise<BrowserFinding[]> {
  const serversRoot = options.serversRoot ?? marketplacePaths().mcpServers;
  const installed = BROWSER_CAPABILITIES.filter((name) =>
    existsSync(mcpServerFile(serversRoot, name)),
  );
  if (!installed.length) return [];
  const finding = (severity: BrowserFinding["severity"], message: string) => [
    { code: "BROWSER" as const, severity, message, fixable: false as const },
  ];
  const probe = options.listening ?? chromeDebuggingListening;
  const root =
    options.profileRoot ??
    selectedBrowserProfile({
      stored: () =>
        keychainStore().get(BROWSER_CAPABILITY, BROWSER_PROFILE_VARIABLE),
    });
  const label = browserLabel(root);
  const major = (options.major ?? browserMajorVersion)(root);
  if (major !== undefined && major < MIN_AUTO_CONNECT_MAJOR)
    return finding(
      "WARN",
      `${label} is on Chromium ${major}; attaching needs ${MIN_AUTO_CONNECT_MAJOR} or later: update the browser`,
    );
  if (await probe(path.join(root, "DevToolsActivePort")))
    return finding(
      "OK",
      `${installed.join(", ")} installed and ${label} debugging is listening`,
    );
  const other = (await listeningBrowsers({ listening: probe })).find(
    (each) => each.root !== root,
  );
  return other
    ? finding(
        "WARN",
        `${installed.join(", ")} attaches to ${label}, but only ${other.label} has debugging on: run \`ocean browser use ${other.id}\``,
      )
    : finding(
        "WARN",
        `${installed.join(", ")} installed, but ${label} is closed or its inspect page's remote-debugging is off (a sandboxed shell that blocks loopback also sees this)`,
      );
}
