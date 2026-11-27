import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { assertProfileName, type Profile } from "../domain/profiles/profile.js";
import { parseProfileMarkdown } from "../domain/profiles/profile-markdown.js";
import { validateProfile } from "../domain/profiles/profile-validator.js";
import { resolveWithin } from "./paths.js";
import { profilesDir } from "./profile-files.js";

function missingAsNull(error: unknown): null {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
}

// The parser's message quotes the text around the error, which could be part of a secret
// pasted into the file, so only the file is named.
function parseProfile(source: string, file: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`Invalid profile JSON in ${file}`);
  }
}

function asRecord(value: unknown, file: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Profile ${file} must be an object`);
  return value as Record<string, unknown>;
}

// The name inside the file must be the name it was loaded by: the name keys sessions and the
// profile's memory namespace, so a mismatch would read or write another profile's facts.
function requireName(
  raw: { name?: unknown },
  name: string,
  file: string,
): void {
  if (raw.name !== name)
    throw new Error(
      `Profile ${file} declares name "${String(raw.name)}", expected "${name}"`,
    );
}

// One profile's own fields, unvalidated and before inheritance; the name is checked by the
// caller, after validation, so an invalid name is reported as invalid first. `<name>.md` and `<name>.json`
// together are ambiguous and refused; only a missing canonical file falls through to the
// legacy directory form, and a file that exists but cannot be read or parsed is an error,
// never a silent fallback.
async function readRawProfile(
  name: string,
): Promise<{ raw: Record<string, unknown>; file: string }> {
  assertProfileName(name);
  const root = profilesDir();
  const markdownFile = resolveWithin(root, `${name}.md`);
  const jsonFile = resolveWithin(root, `${name}.json`);
  const markdown = await readFile(markdownFile, "utf8").catch(missingAsNull);
  const json = await readFile(jsonFile, "utf8").catch(missingAsNull);
  if (markdown !== null && json !== null)
    throw new Error(
      `Profile ${name} exists as both ${name}.md and ${name}.json; keep one`,
    );
  if (markdown !== null)
    return {
      raw: parseProfileMarkdown(markdown, markdownFile),
      file: markdownFile,
    };
  if (json !== null)
    return {
      raw: asRecord(parseProfile(json, jsonFile), jsonFile),
      file: jsonFile,
    };
  const directory = resolveWithin(root, name);
  if ((await stat(directory).catch(missingAsNull))?.isDirectory()) {
    const legacy = path.join(directory, "profile.json");
    const input = asRecord(
      parseProfile(await readFile(legacy, "utf8"), legacy),
      legacy,
    );
    const instructions = await readFile(
      path.join(directory, "instructions.md"),
      "utf8",
    ).catch(() => "");
    return {
      raw: { ...input, instructions },
      file: legacy,
    };
  }
  throw new Error(`Profile not found: ${name}`);
}

// A chain deeper than this is a mistake, not a design.
const MAX_EXTENDS = 4;

// `extends: <parent>` (T-338): the child's fields replace the parent's, key by key (a nested
// map such as `clients` is replaced whole, never merged). `name` and `extends` are the child's.
// A parent must declare its own file's name, like any profile.
async function resolveRawProfile(
  name: string,
  chain: string[] = [],
): Promise<{ raw: Record<string, unknown>; file: string }> {
  if (chain.includes(name))
    throw new Error(
      `Profile inheritance cycle: ${[...chain, name].join(" → ")}`,
    );
  if (chain.length > MAX_EXTENDS)
    throw new Error(
      `Profile ${chain[0]} extends more than ${MAX_EXTENDS} deep`,
    );
  const own = await readRawProfile(name);
  const parentName = own.raw.extends;
  if (parentName === undefined) return own;
  if (typeof parentName !== "string")
    throw new Error(`Profile ${name}: extends must be a profile name`);
  const parent = await resolveRawProfile(parentName, [...chain, name]);
  requireName(parent.raw, parentName, parent.file);
  const { extends: _parentExtends, ...inherited } = parent.raw;
  return { raw: { ...inherited, ...own.raw }, file: own.file };
}

export async function loadProfile(name: string): Promise<Profile> {
  const { raw, file } = await resolveRawProfile(name);
  const profile = validateProfile(raw);
  requireName(profile, name, file);
  return profile;
}
