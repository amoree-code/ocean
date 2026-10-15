import { readFile } from "node:fs/promises";

export async function oceanVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string" || !manifest.version.trim())
    throw new Error("package.json must declare a non-empty version");
  return manifest.version;
}
