import { readFile } from "node:fs/promises";

// The version the MCP servers report, read from this package's manifest (T-307: it was
// hard-coded and drifted from the release).
let cached: string | undefined;

// Cached on first read, which a server does at `initialize`: the version this process started
// as, even after a newer release is installed over it (T-313: a stale server is detected by it).
export async function serverVersion(): Promise<string> {
  cached ??= await installedVersion();
  return cached;
}

// Read from disk on every call: what is installed now, whatever this process started as.
export async function installedVersion(): Promise<string> {
  try {
    const manifest = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof manifest.version === "string" && manifest.version.trim()
      ? manifest.version
      : "unknown";
  } catch {
    return "unknown";
  }
}
