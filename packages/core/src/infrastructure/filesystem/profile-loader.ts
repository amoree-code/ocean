import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  assertProfileName,
  type Profile,
} from "../../domain/profiles/profile.js";
import { validateProfile } from "../../domain/profiles/profile-validator.js";
import { oceanPath, resolveWithin, SYSTEM_DIR } from "../../paths.js";

function missingAsNull(error: unknown): null {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
}

function parseProfile(source: string, file: string): unknown {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(
      `Invalid profile JSON in ${file}: ${(error as Error).message}`,
    );
  }
}

// The name inside the file must be the name it was loaded by: the name keys sessions and the
// profile's memory namespace, so a mismatch would read or write another profile's facts.
function requireName(profile: Profile, name: string, file: string): Profile {
  if (profile.name !== name)
    throw new Error(
      `Profile ${file} declares name "${profile.name}", expected "${name}"`,
    );
  return profile;
}

export async function loadProfile(name: string): Promise<Profile> {
  assertProfileName(name);
  const root = oceanPath(SYSTEM_DIR, "profiles");
  const file = resolveWithin(root, `${name}.json`);
  // Only a missing canonical file falls through to the legacy directory form; a file that
  // exists but cannot be read, parsed or validated is an error, never a silent fallback.
  const source = await readFile(file, "utf8").catch(missingAsNull);
  if (source !== null)
    return requireName(validateProfile(parseProfile(source, file)), name, file);
  const directory = resolveWithin(root, name);
  if ((await stat(directory).catch(missingAsNull))?.isDirectory()) {
    const legacy = path.join(directory, "profile.json");
    const input = parseProfile(
      await readFile(legacy, "utf8"),
      legacy,
    ) as Record<string, unknown>;
    const instructions = await readFile(
      path.join(directory, "instructions.md"),
      "utf8",
    ).catch(() => "");
    return requireName(
      validateProfile({ ...input, instructions }),
      name,
      legacy,
    );
  }
  throw new Error(`Profile not found: ${name}`);
}
