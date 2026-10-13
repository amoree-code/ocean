import { readFile } from "node:fs/promises";
import {
  type RuntimeConfig,
  validateRuntimeConfig,
} from "../../domain/profiles/runtime-config.js";
import { oceanPath, SYSTEM_DIR } from "../../paths.js";

export function runtimeConfigFile(): string {
  return oceanPath(SYSTEM_DIR, "config", "runtime.json");
}

// null only when the file does not exist; a file that exists but is not valid is an error.
export async function loadRuntimeConfig(): Promise<RuntimeConfig | null> {
  const file = runtimeConfigFile();
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `Invalid runtime config JSON in ${file}: ${(error as Error).message}`,
    );
  }
  return validateRuntimeConfig(input);
}
