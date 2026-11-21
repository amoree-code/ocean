import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mcpServerFile } from "@ocean/market/adapters/mcp-adapter.js";
import { marketplacePaths } from "@ocean/market/install/default-marketplace.js";
import { BROWSER_CAPABILITY } from "@ocean/market/mcp/chrome-debugging.js";
import type { SecretStore } from "@ocean/market/security/secrets.js";

// Settings of ocean-browser-mcp (T-324), stored like `ocean browser use`: one value per
// variable in the secret store, read by every client's launch of `dev.ocean/chrome-devtools`.
// Restart open clients after a change.
export const PROFILE_VARIABLE = "OCEAN_BROWSER_PROFILE";
export const BLOCKED_VARIABLE = "OCEAN_BROWSER_BLOCKED";
export const BROWSER_PROFILES = ["standard", "full", "lean", "slim"] as const;
const DEFAULT_PROFILE = "standard";

// `dev.ocean/firefox-devtools` keeps its own profile folder once `ocean browser use firefox`
// names one; unset, Mozilla's server starts a fresh temporary profile each run.
export const FIREFOX_CAPABILITY = "dev.ocean/firefox-devtools";
export const FIREFOX_PROFILE_VARIABLE = "OCEAN_FIREFOX_PROFILE";

export function firefoxProfileDir(env: NodeJS.ProcessEnv = process.env) {
  const base = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "ocean-firefox", "profile");
}

export function useFirefox(store: SecretStore, env = process.env) {
  const profile = firefoxProfileDir(env);
  store.set(FIREFOX_CAPABILITY, FIREFOX_PROFILE_VARIABLE, profile);
  return {
    browser: "Firefox",
    capability: FIREFOX_CAPABILITY,
    profile,
    in: store.name,
    next: `ocean market add ${FIREFOX_CAPABILITY} (once), then restart open clients. To drive your own running Firefox instead, start it with --marionette --remote-debugging-port and set CONNECT_EXISTING=true.`,
  };
}

// `ocean browser profile [standard|full|lean|slim]`: which tools clients see.
export function browserProfile(store: SecretStore, name?: string) {
  if (name !== undefined) {
    const chosen = name.trim().toLowerCase();
    if (!(BROWSER_PROFILES as readonly string[]).includes(chosen))
      throw new Error(
        `Usage: ocean browser profile <${BROWSER_PROFILES.join("|")}>`,
      );
    if (chosen === DEFAULT_PROFILE)
      store.remove(BROWSER_CAPABILITY, PROFILE_VARIABLE);
    else store.set(BROWSER_CAPABILITY, PROFILE_VARIABLE, chosen);
  }
  return {
    profile: store.get(BROWSER_CAPABILITY, PROFILE_VARIABLE) ?? DEFAULT_PROFILE,
    profiles: {
      standard:
        "default: browsing, forms, network, console, Lighthouse, traces",
      full: "every upstream tool",
      lean: "browsing only: no performance, emulation, CSS or drag tools",
      slim: "3 tools: navigate, evaluate, screenshot",
    },
    ...(name === undefined ? {} : { next: "restart open clients" }),
  };
}

// `ocean browser block [list|add <pattern>|rm <pattern>]`: URL patterns
// (https://urlpattern.spec.whatwg.org/) the browser refuses while an agent is attached.
// Stored comma-separated: the keychain's command form keeps a value on one line.
export function browserBlocklist(
  store: SecretStore,
  action = "list",
  pattern?: string,
) {
  const read = () =>
    (store.get(BROWSER_CAPABILITY, BLOCKED_VARIABLE) ?? "")
      .split(/[\n,]/)
      .map((each) => each.trim())
      .filter(Boolean);
  let patterns = read();
  if (action === "add" || action === "rm") {
    const value = pattern?.trim();
    if (!value || value.includes(","))
      throw new Error(
        `Usage: ocean browser block ${action} <url-pattern> (no commas), e.g. https://*.mybank.com/*`,
      );
    patterns =
      action === "add"
        ? [...new Set([...patterns, value])]
        : patterns.filter((each) => each !== value);
    if (patterns.length)
      store.set(BROWSER_CAPABILITY, BLOCKED_VARIABLE, patterns.join(","));
    else store.remove(BROWSER_CAPABILITY, BLOCKED_VARIABLE);
  } else if (action !== "list")
    throw new Error("Usage: ocean browser block list|add|rm <url-pattern>");
  return {
    blocked: patterns,
    ...(action === "list" ? {} : { next: "restart open clients" }),
  };
}

// The wrapper's own state folder (usage log, screenshot previews); same rule as its stateDir().
export function browserStateDir(env: NodeJS.ProcessEnv = process.env) {
  if (env.OCEAN_BROWSER_STATE_DIR) return env.OCEAN_BROWSER_STATE_DIR;
  const base = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "ocean-browser-mcp");
}

type UsageLine = {
  t?: string;
  client?: string;
  tool?: string;
  chars?: number;
  images?: number;
  imageKB?: number;
  ms?: number;
  error?: boolean;
};

// `ocean browser usage [--days N]`: totals per tool from the wrapper's usage log. Text is
// counted in characters (about 4 per token); images in KB as sent.
export function browserUsage(
  dir = browserStateDir(),
  options: { days?: number; now?: number } = {},
) {
  const now = options.now ?? Date.now();
  const since = options.days ? now - options.days * 86_400_000 : 0;
  const lines: UsageLine[] = [];
  for (const file of ["usage.1.jsonl", "usage.jsonl"]) {
    const full = path.join(dir, file);
    if (!existsSync(full)) continue;
    for (const raw of readFileSync(full, "utf8").split("\n")) {
      if (!raw.trim()) continue;
      try {
        const line = JSON.parse(raw) as UsageLine;
        if (line.tool && (!since || Date.parse(line.t ?? "") >= since))
          lines.push(line);
      } catch {
        // A line cut by a crash is skipped.
      }
    }
  }
  const tools = new Map<
    string,
    {
      calls: number;
      chars: number;
      imageKB: number;
      ms: number;
      errors: number;
    }
  >();
  for (const line of lines) {
    const row = tools.get(line.tool as string) ?? {
      calls: 0,
      chars: 0,
      imageKB: 0,
      ms: 0,
      errors: 0,
    };
    row.calls += 1;
    row.chars += line.chars ?? 0;
    row.imageKB += line.imageKB ?? 0;
    row.ms += line.ms ?? 0;
    if (line.error) row.errors += 1;
    tools.set(line.tool as string, row);
  }
  const rows = [...tools.entries()]
    .map(([tool, row]) => ({
      tool,
      calls: row.calls,
      textTokens: Math.round(row.chars / 4),
      imageKB: Math.round(row.imageKB),
      avgMs: Math.round(row.ms / row.calls),
      errors: row.errors,
    }))
    .sort((a, b) => b.textTokens - a.textTokens);
  return {
    log: path.join(dir, "usage.jsonl"),
    calls: lines.length,
    textTokens: rows.reduce((sum, row) => sum + row.textTokens, 0),
    imageKB: rows.reduce((sum, row) => sum + row.imageKB, 0),
    since: lines[0]?.t,
    tools: rows,
  };
}

// The ocean-browser-mcp version the installed capability runs, so `status`/`stop` talk to the
// daemons that version started.
export function installedWrapperVersion(
  serversRoot = marketplacePaths().mcpServers,
): string | undefined {
  try {
    const server = JSON.parse(
      readFileSync(mcpServerFile(serversRoot, BROWSER_CAPABILITY), "utf8"),
    );
    const found = (server?.server?.packages ?? server?.packages ?? []).find(
      (each: { identifier?: string }) =>
        each?.identifier === "ocean-browser-mcp",
    );
    return found?.version;
  } catch {
    return undefined;
  }
}

// `ocean browser status|stop`: the wrapper lists or stops its shared background connections
// (the browser stays open; the next call reconnects and the browser asks to allow it again).
export function browserConnection(action: "status" | "stop") {
  const version = installedWrapperVersion();
  if (!version)
    throw new Error(
      `${BROWSER_CAPABILITY} is not installed: ocean market add ${BROWSER_CAPABILITY}`,
    );
  const result = spawnSync(
    "npx",
    ["-y", `ocean-browser-mcp@${version}`, action],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}
