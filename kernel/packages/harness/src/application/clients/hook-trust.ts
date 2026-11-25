import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type ClientEnv,
  type ClientFinding,
  defaultClientEnv,
  planClients,
} from "./clients.js";
import { type HookEvent, oceanHookEvent } from "./hooks.js";

// Hook trust (T-336). Codex runs a hook from hooks.json only after the owner trusts it: it keeps
// `[hooks.state."<file>:<event>:<group>:<hook>"] trusted_hash = "sha256:…"` in config.toml and
// asks again ("Hooks need review") whenever a hook is new or changed. An untrusted SessionEnd
// hook never runs, so the session is never recorded. Ocean only reports this: writing
// `trusted_hash` itself would skip a security check on the owner's behalf. Presence is all that
// is checked — the hash is Codex's own, so a stale one shows up as Codex's review prompt.
// The other clients with Ocean hooks (Claude Code, Gemini CLI, Qwen Code, Cursor) have no
// per-hook trust step.

export type HookTrust = {
  client: string;
  event: HookEvent;
  key: string;
  trusted: boolean;
};

const snake = (event: string) =>
  event.replace(
    /[A-Z]/g,
    (letter, at) => `${at ? "_" : ""}${letter.toLowerCase()}`,
  );

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

// A TOML basic or literal string's value.
const tomlString = (quoted: string) =>
  quoted.startsWith("'")
    ? quoted.slice(1, -1)
    : quoted.slice(1, -1).replace(/\\(["\\])/g, "$1");

const KEY = String.raw`("(?:[^"\\]|\\.)*"|'[^']*')`;

// The hook keys config.toml holds a trusted_hash for, in either shape Codex accepts:
// `[hooks.state."<key>"]` tables, or `"<key>" = { trusted_hash = … }` under `[hooks.state]`.
export function trustedHookKeys(configToml: string): Set<string> {
  const trusted = new Set<string>();
  const table = new RegExp(String.raw`^\[\s*hooks\.state\.${KEY}\s*\]$`);
  const inline = new RegExp(
    String.raw`^${KEY}\s*=\s*\{[^}]*\btrusted_hash\s*=\s*["']sha256:`,
  );
  let section = "";
  let key: string | undefined;
  for (const raw of configToml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      const match = table.exec(line);
      key = match ? tomlString(match[1]) : undefined;
      section = match ? "" : line.replace(/\s+/g, "");
      continue;
    }
    if (key && /^trusted_hash\s*=\s*["']sha256:/.test(line)) trusted.add(key);
    if (section === "[hooks.state]") {
      const match = inline.exec(line);
      if (match) trusted.add(tomlString(match[1]));
    }
  }
  return trusted;
}

// Every Ocean hook in Codex's hooks.json, with the trust key Codex gives it.
export function codexHookTrust(
  hooksJson: string,
  configToml: string,
  hooksFile: string,
): HookTrust[] {
  let root: unknown;
  try {
    root = JSON.parse(hooksJson);
  } catch {
    return [];
  }
  const events = (root as { hooks?: unknown } | null)?.hooks;
  if (!events || typeof events !== "object") return [];
  const trusted = trustedHookKeys(configToml);
  const found: HookTrust[] = [];
  for (const [name, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, groupIndex) => {
      const hooks = (group as { hooks?: unknown } | null)?.hooks;
      if (!Array.isArray(hooks)) return;
      hooks.forEach((hook, hookIndex) => {
        const event = oceanHookEvent(
          (hook as { command?: unknown } | null)?.command,
        );
        if (!event) return;
        const key = `${hooksFile}:${snake(name)}:${groupIndex}:${hookIndex}`;
        found.push({ client: "codex", event, key, trusted: trusted.has(key) });
      });
    });
  }
  return found;
}

const FIX =
  'open Codex and choose "Trust all and continue" when it asks "Hooks need review", or trust it under /hooks. Ocean does not trust hooks for you';

// `ocean doctor`: one finding per installed client that has a per-hook trust step.
export async function hookTrustFindings(
  env: ClientEnv = defaultClientEnv(),
): Promise<ClientFinding[]> {
  const installed = (await planClients(env)).some(
    (plan) => plan.installed && plan.client === "codex",
  );
  if (!installed) return [];
  const hooksFile = path.join(env.home, ".codex", "hooks.json");
  const hooks = codexHookTrust(
    await readText(hooksFile),
    await readText(path.join(env.home, ".codex", "config.toml")),
    hooksFile,
  );
  if (!hooks.length) return [];
  const untrusted = hooks.filter((hook) => !hook.trusted);
  if (!untrusted.length)
    return [
      {
        code: "HOOK_TRUST",
        severity: "OK",
        message: `codex: Ocean's ${hooks.map((hook) => hook.event).join(", ")} hooks are trusted`,
        fixable: false,
      },
    ];
  return untrusted.map((hook) => ({
    code: "HOOK_UNTRUSTED",
    severity: "WARN",
    message: `codex: Ocean's ${hook.event} hook is not trusted, so Codex never runs it${hook.event === "SessionEnd" ? " and its sessions are not recorded" : ""} — ${FIX}`,
    fixable: false,
  }));
}
