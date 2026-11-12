import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";

// Chrome writes the port of its debugging server here while chrome://inspect/#remote-debugging is
// on; `chrome-devtools-mcp --autoConnect` reads the same file to attach to the running browser.
export function devToolsPortFile(
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const parts =
    platform === "darwin"
      ? [home, "Library", "Application Support", "Google", "Chrome"]
      : platform === "win32"
        ? [
            env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
            "Google",
            "Chrome",
            "User Data",
          ]
        : [home, ".config", "google-chrome"];
  return path.join(...parts, "DevToolsActivePort");
}

// A plain TCP connect: it tells whether Chrome's debugging server is up without opening a DevTools
// session, so it never raises Chrome's permission prompt.
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
