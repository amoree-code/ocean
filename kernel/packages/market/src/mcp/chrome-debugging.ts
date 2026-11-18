import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";

// The capability that attaches to the owner's running browser, and the value that names which
// browser: a profile root, passed to chrome-devtools-mcp as `--userDataDir`. Unset means Chrome.
export const BROWSER_CAPABILITY = "dev.ocean/chrome-devtools";
export const BROWSER_PROFILE_VARIABLE = "OCEAN_BROWSER_USER_DATA_DIR";

type Platform = NodeJS.Platform;
type Roots = { darwin?: string[]; win32?: string[]; linux?: string[] };

// Chromium browsers and where each keeps its profile root, which is where the browser writes
// DevToolsActivePort while its inspect page's remote debugging is on. Windows paths are under
// %LOCALAPPDATA% unless marked roaming; Linux paths are under ~/.config.
export const CHROMIUM_BROWSERS: ReadonlyArray<{
  id: string;
  label: string;
  roots: Roots;
  roaming?: boolean;
}> = [
  {
    id: "chrome",
    label: "Chrome",
    roots: {
      darwin: ["Google", "Chrome"],
      win32: ["Google", "Chrome", "User Data"],
      linux: ["google-chrome"],
    },
  },
  {
    id: "chrome-beta",
    label: "Chrome Beta",
    roots: {
      darwin: ["Google", "Chrome Beta"],
      win32: ["Google", "Chrome Beta", "User Data"],
      linux: ["google-chrome-beta"],
    },
  },
  {
    id: "chrome-canary",
    label: "Chrome Canary",
    roots: {
      darwin: ["Google", "Chrome Canary"],
      win32: ["Google", "Chrome SxS", "User Data"],
      linux: ["google-chrome-canary"],
    },
  },
  {
    id: "chromium",
    label: "Chromium",
    roots: {
      darwin: ["Chromium"],
      win32: ["Chromium", "User Data"],
      linux: ["chromium"],
    },
  },
  {
    id: "brave",
    label: "Brave",
    roots: {
      darwin: ["BraveSoftware", "Brave-Browser"],
      win32: ["BraveSoftware", "Brave-Browser", "User Data"],
      linux: ["BraveSoftware", "Brave-Browser"],
    },
  },
  {
    id: "edge",
    label: "Microsoft Edge",
    roots: {
      darwin: ["Microsoft Edge"],
      win32: ["Microsoft", "Edge", "User Data"],
      linux: ["microsoft-edge"],
    },
  },
  {
    id: "vivaldi",
    label: "Vivaldi",
    roots: {
      darwin: ["Vivaldi"],
      win32: ["Vivaldi", "User Data"],
      linux: ["vivaldi"],
    },
  },
  {
    id: "opera",
    label: "Opera",
    roaming: true,
    roots: {
      darwin: ["com.operasoftware.Opera"],
      win32: ["Opera Software", "Opera Stable"],
      linux: ["opera"],
    },
  },
  {
    id: "arc",
    label: "Arc",
    roots: { darwin: ["Arc", "User Data"] },
  },
];

// A browser's profile root on this platform, or undefined when it has none here.
export function browserProfileRoot(
  id: string,
  home = os.homedir(),
  platform: Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const browser = CHROMIUM_BROWSERS.find((each) => each.id === id);
  const parts =
    platform === "darwin" || platform === "win32"
      ? browser?.roots[platform]
      : browser?.roots.linux;
  if (!browser || !parts) return undefined;
  const base =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : platform === "win32"
        ? browser.roaming
          ? (env.APPDATA ?? path.join(home, "AppData", "Roaming"))
          : (env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"))
        : path.join(home, ".config");
  return path.join(base, ...parts);
}

// `ocean browser use <name|path>`: a known browser's profile root, or an absolute path as given
// (a custom profile, or a Chromium browser not in the list).
export function resolveBrowserChoice(
  choice: string,
  home = os.homedir(),
  platform: Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (path.isAbsolute(choice)) return path.resolve(choice);
  const root = browserProfileRoot(choice.toLowerCase(), home, platform, env);
  if (root) return root;
  const known = CHROMIUM_BROWSERS.filter((each) =>
    browserProfileRoot(each.id, home, platform, env),
  ).map((each) => each.id);
  throw new Error(
    `unknown browser "${choice}" on ${platform}: use one of ${known.join(", ")}, or an absolute profile path`,
  );
}

// The name a profile root goes by, for messages.
export function browserLabel(
  root: string,
  home = os.homedir(),
  platform: Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const browser = CHROMIUM_BROWSERS.find(
    (each) => browserProfileRoot(each.id, home, platform, env) === root,
  );
  return browser ? browser.label : `the browser at ${root}`;
}

// The browser chosen for this machine: the environment, then the stored choice, then Chrome.
export function selectedBrowserProfile(
  options: {
    env?: NodeJS.ProcessEnv;
    stored?: () => string | undefined;
    home?: string;
    platform?: Platform;
  } = {},
): string {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  return (
    env[BROWSER_PROFILE_VARIABLE] ??
    options.stored?.() ??
    (browserProfileRoot("chrome", home, platform, env) as string)
  );
}

// The browser writes the port of its debugging server here while its inspect page's remote
// debugging is on; `chrome-devtools-mcp --autoConnect` reads the same file to attach to it.
export function devToolsPortFile(
  home = os.homedir(),
  platform: Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  profileRoot = browserProfileRoot("chrome", home, platform, env) as string,
): string {
  return path.join(profileRoot, "DevToolsActivePort");
}

// A plain TCP connect: it tells whether a browser's debugging server is up without opening a
// DevTools session, so it never raises the browser's permission prompt.
export async function chromeDebuggingListening(
  file = devToolsPortFile(),
): Promise<boolean> {
  let port: number;
  try {
    port = Number((await readFile(file, "utf8")).split("\n")[0]);
  } catch {
    return false;
  }
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return false;
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 1000 });
    const finish = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

// Every known browser on this platform whose debugging server is listening right now.
export async function listeningBrowsers(
  options: {
    home?: string;
    platform?: Platform;
    env?: NodeJS.ProcessEnv;
    listening?: (portFile: string) => Promise<boolean>;
  } = {},
): Promise<{ id: string; label: string; root: string }[]> {
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const probe = options.listening ?? chromeDebuggingListening;
  const found = await Promise.all(
    CHROMIUM_BROWSERS.map(async (browser) => {
      const root = browserProfileRoot(browser.id, home, platform, env);
      return root && (await probe(path.join(root, "DevToolsActivePort")))
        ? { id: browser.id, label: browser.label, root }
        : undefined;
    }),
  );
  return found.filter((each) => each !== undefined);
}
