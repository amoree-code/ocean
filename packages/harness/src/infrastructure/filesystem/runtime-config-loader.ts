import { readFile } from "node:fs/promises";
import {
  type RuntimeConfig,
  validateRuntimeConfig,
} from "@ocean/core/domain/profiles/runtime-config.js";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";

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
  } catch {
    // The parser's message quotes the file around the error; it is not repeated.
    throw new Error(`Invalid runtime config JSON in ${file}`);
  }
  return validateRuntimeConfig(input);
}
