import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Claude chat (Desktop, claude.ai, phone) runs on Anthropic's servers: it gets Ocean's tools from
// the MCP entry Ocean writes, but it drops the server's `instructions` and runs no hooks. A skill
// does reach it: an account plugin's skills load in chat, Cowork and Claude Code, and Claude
// loads one by itself when a message matches its description (T-328: asked "where your memory
// lives" with the ocean-memory skill installed, chat called brain_search and named Ocean).
//
// The plugin lives in Ocean's public repository (`.claude-plugin/marketplace.json` at its root,
// `kernel/plugins/ocean/`), so a release reaches every device without Ocean touching it. Adding a
// marketplace to a Claude account has no API, deep link or config file: the owner adds it once
// in Claude's settings. Ocean makes that one step short — the name on the clipboard, Claude open
// — and checks for it where Claude Code keeps its copy of the account's marketplaces.

export const OCEAN_MARKETPLACE = "amoree-code/ocean";

export const CHAT_PLUGIN_STEPS = [
  "In Claude: Customize → Plugins → Add → Add marketplace",
  `Paste ${OCEAN_MARKETPLACE} and add it`,
  "Install the Ocean plugin it lists",
  "Skills need Settings → Capabilities → Code execution on",
];

function syncedDir(home: string): string {
  return path.join(home, ".claude", "plugins", "synced");
}

// True once the account lists Ocean's marketplace. Claude Code (v2.1.273 and later) mirrors the
// account's marketplaces into ~/.claude/plugins/synced/<account>_<org>/.marketplaces.json; the
// row's source names the repository. Undefined when that mirror does not exist, so absence of
// Claude Code never reads as "not added".
export function chatPluginAdded(home = os.homedir()): boolean | undefined {
  let accounts: string[];
  try {
    accounts = readdirSync(syncedDir(home));
  } catch {
    return undefined;
  }
  let mirrored = false;
  for (const account of accounts) {
    let rows: unknown;
    try {
      rows = (
        JSON.parse(
          readFileSync(
            path.join(syncedDir(home), account, ".marketplaces.json"),
            "utf8",
          ),
        ) as { rows?: unknown }
      ).rows;
    } catch {
      continue;
    }
    if (!Array.isArray(rows)) continue;
    mirrored = true;
    const wanted = OCEAN_MARKETPLACE.toLowerCase();
    if (
      rows.some((row) =>
        JSON.stringify((row as { source?: unknown })?.source ?? "")
          .toLowerCase()
          .includes(wanted),
      )
    )
      return true;
  }
  return mirrored ? false : undefined;
}

export type ChatPluginOpen = { copied: boolean; opened: boolean };

type Run = (file: string, args: string[], input?: string) => void;

const run: Run = (file, args, input) => {
  execFileSync(file, args, {
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "ignore", "ignore"],
    timeout: 10_000,
  });
};

// Puts the marketplace name on the clipboard and brings Claude up, so the step is a paste and a
// few clicks. Either half failing leaves the printed steps, which say the same.
export function openChatPluginSetup(
  options: { platform?: NodeJS.Platform; exec?: Run } = {},
): ChatPluginOpen {
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? run;
  const attempt = (file: string, args: string[], input?: string) => {
    try {
      exec(file, args, input);
      return true;
    } catch {
      return false;
    }
  };
  if (platform === "darwin")
    return {
      copied: attempt("pbcopy", [], OCEAN_MARKETPLACE),
      opened: attempt("open", ["-a", "Claude"]),
    };
  if (platform === "win32")
    return {
      copied: attempt("clip", [], OCEAN_MARKETPLACE),
      opened: false,
    };
  return { copied: false, opened: false };
}
