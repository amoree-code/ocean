import { readdir, readFile } from "node:fs/promises";
import {
  CHARTER_DIR,
  oceanPath,
  POLICIES_DIR,
  resolveWithin,
} from "./paths.js";

// The owner's rules: `charter/core.md` and the policy modules beside it. One reader for
// `ocean policy` and the `ocean_policy` MCP tool, so a hookless client reads what a CLI reads.

const NAME = /^[a-z][a-z-]*$/;
// `core` is the bootstrap itself, the rest are the policy files.
export const CORE_RULES = "core";

export async function policyNames(): Promise<string[]> {
  const entries = await readdir(oceanPath(POLICIES_DIR), {
    withFileTypes: true,
  }).catch(() => []);
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        entry.name !== "README.md",
    )
    .map((entry) => entry.name.slice(0, -3))
    .sort();
}

export async function readCoreRules(): Promise<string | null> {
  return readFile(oceanPath(CHARTER_DIR, "core.md"), "utf8").catch(() => null);
}

// `core` or one policy's text; an unknown or malformed name throws.
export async function readRules(name: string): Promise<string> {
  if (name === CORE_RULES) {
    const core = await readCoreRules();
    if (core === null) throw new Error("No rules: charter/core.md is missing");
    return core;
  }
  if (!NAME.test(name) || !(await policyNames()).includes(name))
    throw new Error(`Unknown policy: ${name}`);
  return readFile(resolveWithin(oceanPath(POLICIES_DIR), `${name}.md`), "utf8");
}

// For a client with no hook: which `ocean_policy` names hold the language and report rules.
// Null when the user has no rules, so nothing points at an empty store.
export async function rulesPointer(): Promise<string | null> {
  if ((await readCoreRules()) === null) return null;
  const response = (await policyNames()).includes("response")
    ? ', "response" (report shape)'
    : "";
  return `Rules: before your first substantial reply, call ocean_policy with name "core" (language, direction, working style)${response}.`;
}
