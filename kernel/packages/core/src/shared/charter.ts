import { readdir, readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import {
  compileTriggers,
  prepareText,
  triggerHits,
} from "./context-triggers.js";
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

// For a client with no hook: the rules arrive through `ocean_context` (T-339 P1 folded
// `ocean_policy` into it). Null when the user has no rules, so nothing points at an empty store.
export async function rulesPointer(): Promise<string | null> {
  if ((await readCoreRules()) === null) return null;
  return 'Rules: before your first substantial reply, call ocean_context with policy "core" (language, direction, hard boundaries); a policy\'s full text: the same call with its name.';
}

// ── Policy catalog (T-339 P1) ────────────────────────────────────────────────────────────────
// Each policy declares in its frontmatter the words that summon it (`triggers:`, English and
// Iraqi Arabic) and its hard lines (`digest:`, 200 bytes or less). The prompt hook injects the
// digest of at most two matching policies per prompt, once per session; a hookless client gets
// the list from `ocean_context`.

export const POLICY_DIGEST_MAX_BYTES = 200;
export const POLICIES_PER_PROMPT = 2;

export type PolicyEntry = {
  name: string;
  triggers: string[];
  digest: string;
  // Problems `ocean policy validate` reports; an entry with problems is still routed.
  problems: string[];
};

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parsePolicy(name: string, text: string): PolicyEntry {
  const problems: string[] = [];
  let fields: Record<string, unknown> = {};
  const match = FENCE.exec(text.replace(/^﻿/, ""));
  if (!match) problems.push("no frontmatter");
  else
    try {
      const parsed = parseYaml(match[1] ?? "", { prettyErrors: false });
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        fields = parsed as Record<string, unknown>;
      else problems.push("frontmatter is not a mapping");
    } catch {
      problems.push("frontmatter is not valid YAML");
    }
  const triggers = Array.isArray(fields.triggers)
    ? fields.triggers.filter(
        (item): item is string => typeof item === "string" && !!item.trim(),
      )
    : [];
  const digest = typeof fields.digest === "string" ? fields.digest.trim() : "";
  if (match && !triggers.length) problems.push("no triggers");
  if (match && !digest) problems.push("no digest");
  if (Buffer.byteLength(digest, "utf8") > POLICY_DIGEST_MAX_BYTES)
    problems.push(`digest over ${POLICY_DIGEST_MAX_BYTES} bytes`);
  return { name, triggers, digest, problems };
}

export async function policyCatalog(): Promise<PolicyEntry[]> {
  const out: PolicyEntry[] = [];
  for (const name of await policyNames()) {
    const text = await readFile(
      resolveWithin(oceanPath(POLICIES_DIR), `${name}.md`),
      "utf8",
    ).catch(() => "");
    out.push(parsePolicy(name, text));
  }
  return out;
}

export type PolicyMatch = { name: string; digest: string; why: string[] };

// Most hits first, then name; at most `max`. A slash command or an empty prompt summons nothing.
export function routePolicies(
  catalog: readonly PolicyEntry[],
  prompt: string,
  options: { max?: number } = {},
): PolicyMatch[] {
  const max = options.max ?? POLICIES_PER_PROMPT;
  if (!prompt.trim() || prompt.trimStart().startsWith("/")) return [];
  const text = prepareText(prompt);
  const scored = catalog
    .map((entry) => ({
      entry,
      ...triggerHits(compileTriggers(entry.triggers), text),
    }))
    .filter((item) => item.score > 0 && item.entry.digest)
    .sort(
      (a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name),
    );
  return scored.slice(0, max).map((item) => ({
    name: item.entry.name,
    digest: item.entry.digest,
    why: item.hits,
  }));
}

export function policyLine(match: PolicyMatch): string {
  return `Policy ${match.name}: ${match.digest} — full: ocean policy ${match.name}`;
}
