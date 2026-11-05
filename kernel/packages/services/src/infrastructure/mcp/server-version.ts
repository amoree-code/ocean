import { readFile } from "node:fs/promises";

// The version the MCP servers report, read from this package's manifest (T-307: it was
// hard-coded and drifted from the release).
let cached: string | undefined;

export async function serverVersion(): Promise<string> {
  if (cached) return cached;
  try {
    const manifest = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    cached =
      typeof manifest.version === "string" && manifest.version.trim()
        ? manifest.version
        : "unknown";
  } catch {
    cached = "unknown";
  }
  return cached;
}
