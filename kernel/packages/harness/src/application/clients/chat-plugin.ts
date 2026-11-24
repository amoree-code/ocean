import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { enginePath } from "@ocean/core/shared/paths.js";

// Claude chat (Desktop, claude.ai, phone) runs on Anthropic's servers: it gets Ocean's tools from
// the MCP entry Ocean writes, but it drops the server's `instructions` and runs no hooks. A skill
// does reach it: a skill in the Claude account loads in chat, Cowork and the phone, and Claude
// loads it by itself when a message matches its description (T-328: asked "where your memory
// lives" with the ocean-memory skill installed, chat called brain_search and named Ocean).
//
// Only an upload reaches chat. Claude Desktop's "Add from a repository" installs a marketplace
// plugin locally for its Code tab (its log: "skipping remote API path … reason=local-sourced"),
// so chat never sees it; with only that, chat answered from Anthropic's memory (T-328,
// 2026-11-24). An uploaded skill (`ocean-memory@My Uploads`) is the account's own and loads in
// chat, Cowork and the phone. Uploading has no API: Ocean writes the zip, shows it, opens Claude,
// and checks for it in Desktop's plugin list. Claude Code needs none of this: the session-start
// skill sync copies the same core skill into it.

export const CHAT_SKILL_ZIP = "ocean-memory.zip";

export const CHAT_PLUGIN_STEPS = [
  "In Claude: Customize → Skills → Add → Upload a skill",
  `Pick ${CHAT_SKILL_ZIP} (Ocean saved it to your Downloads folder)`,
  "Skills need Settings → Capabilities → Code execution on",
  'Or in Claude Desktop chat, ask: "Install Ocean\'s memory skill", then save the file it makes',
];

// Where Claude Desktop keeps each signed-in account's plugin list:
// plugin-list/<org>/<account>/plugins.json, rows `{id, name, enabled, installPath}`.
function desktopPluginListDir(
  home: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform === "darwin")
    return path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "plugin-list",
    );
  if (platform === "win32")
    return path.join(
      process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
      "Claude",
      "plugin-list",
    );
  return undefined;
}

const OCEAN_PLUGIN_NAMES = new Set(["ocean", "ocean-memory"]);

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// True when an account Desktop has signed in lists an enabled Ocean plugin, whether it came
// from the marketplace (`ocean@ocean`) or was uploaded (`ocean-memory@My Uploads`). Undefined
// when Desktop keeps no list here.
function desktopListsOcean(
  home: string,
  platform: NodeJS.Platform,
): boolean | undefined {
  const root = desktopPluginListDir(home, platform);
  if (!root) return undefined;
  let listed = false;
  for (const org of subdirs(root))
    for (const account of subdirs(path.join(root, org))) {
      const plugins = (
        readJson(path.join(root, org, account, "plugins.json")) as
          | { plugins?: unknown }
          | undefined
      )?.plugins;
      if (!Array.isArray(plugins)) continue;
      listed = true;
      if (
        plugins.some((row) => {
          const { id, name, enabled } = (row ?? {}) as {
            id?: unknown;
            name?: unknown;
            enabled?: unknown;
          };
          const named =
            (typeof name === "string" && OCEAN_PLUGIN_NAMES.has(name)) ||
            (typeof id === "string" &&
              OCEAN_PLUGIN_NAMES.has(id.split("@")[0]));
          return named && enabled !== false;
        })
      )
        return true;
    }
  return listed ? false : undefined;
}

// True once the ocean-memory skill is in the Claude account, which is what chat and Cowork load,
// read from Claude Desktop's own plugin list. Undefined when Desktop keeps no list here, so a
// machine without Desktop never reads as "not added".
export function chatPluginAdded(
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): boolean | undefined {
  return desktopListsOcean(home, platform);
}

export type ChatPluginOpen = {
  zip?: string;
  revealed: boolean;
  opened: boolean;
};

type Run = (file: string, args: string[], input?: string) => void;

const run: Run = (file, args, input) => {
  execFileSync(file, args, {
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "ignore", "ignore"],
    timeout: 10_000,
  });
};

// A zip of one folder holding SKILL.md, the shape Claude's skill upload takes. Stored, not
// deflated: the file is small and every unzip reads method 0.
export function chatSkillZip(
  skill = readFileSync(
    path.join(enginePath("skills"), "core", "ocean-memory", "SKILL.md"),
  ),
): Buffer {
  const entries: [string, Buffer][] = [
    ["ocean-memory/", Buffer.alloc(0)],
    ["ocean-memory/SKILL.md", skill],
  ];
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const file = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(file.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(file.length, 28);
    dir.writeUInt32LE(name.endsWith("/") ? 0x10 : 0, 38);
    dir.writeUInt32LE(offset, 42);
    local.push(head, file, data);
    central.push(dir, file);
    offset += head.length + file.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

// Saves the skill zip to Downloads, shows it in the file manager and brings Claude up, so the
// step is an upload and a few clicks. Any part failing leaves the printed steps.
export function openChatPluginSetup(
  options: {
    platform?: NodeJS.Platform;
    exec?: Run;
    home?: string;
    zip?: () => Buffer;
  } = {},
): ChatPluginOpen {
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? run;
  const attempt = (file: string, args: string[]) => {
    try {
      exec(file, args);
      return true;
    } catch {
      return false;
    }
  };
  let zip: string | undefined;
  try {
    const dir = path.join(options.home ?? os.homedir(), "Downloads");
    mkdirSync(dir, { recursive: true });
    zip = path.join(dir, CHAT_SKILL_ZIP);
    writeFileSync(zip, (options.zip ?? chatSkillZip)());
  } catch {
    zip = undefined;
  }
  if (platform === "darwin")
    return {
      zip,
      revealed: zip !== undefined && attempt("open", ["-R", zip]),
      opened: attempt("open", ["-a", "Claude"]),
    };
  if (platform === "win32")
    return {
      zip,
      revealed: zip !== undefined && attempt("explorer", [`/select,${zip}`]),
      opened: false,
    };
  return { zip, revealed: false, opened: false };
}
