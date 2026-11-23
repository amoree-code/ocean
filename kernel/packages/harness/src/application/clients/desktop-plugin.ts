import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32 } from "node:zlib";
import { MEMORY_AUTHORITY_LINE } from "@ocean/core/domain/mcp/memory-contract.js";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";

// Claude Desktop's chat has no hook setting Ocean can write, and its own memory prompt outranks
// the MCP server's instructions (T-328: asked alone "where is my memory saved?", chat named
// Anthropic's store). A plugin's SessionStart hook runs in chat and Cowork, so the plugin carries
// the authority line into context before the first turn.
//
// Installed with no user step: Desktop syncs every plugin in its organization plugins folder at
// launch and at each session start, and installs one whose manifest says
// `installationPreference: "required"` (claude.com/docs/third-party/claude-desktop/extensions).
// The folder is admin-only, so writing it asks for the admin password once — and again only
// when the plugin's content changes, since its version is a hash of that content. Hooks from
// that folder do not run in Code sessions, which already get Ocean's own start hook.
//
// Static on purpose: chat hooks run sandboxed (the probe's log write never landed on the host),
// so the hook cannot reach the `ocean` engine.

export const DESKTOP_PLUGIN_NAME = "ocean";

// Where Desktop reads organization plugins; Linux has none. OCEAN_DESKTOP_ORG_PLUGINS overrides.
export function desktopOrgPluginsDir(
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const override = process.env.OCEAN_DESKTOP_ORG_PLUGINS;
  if (override) return override;
  if (platform === "darwin")
    return "/Library/Application Support/Claude/org-plugins";
  if (platform === "win32") return "C:\\Program Files\\Claude\\org-plugins";
  return undefined;
}

function desktopPluginFile(): string {
  return oceanPath(SYSTEM_DIR, "state", "clients", "ocean-desktop-plugin.zip");
}

function desktopPluginStaging(): string {
  return oceanPath(SYSTEM_DIR, "state", "clients", "desktop-plugin");
}

const DESKTOP_PLUGIN_UPLOAD =
  "Claude Desktop → Customize → Plugins → + → Upload plugin, choose this file, then quit Claude (⌘Q) and reopen it";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function hookFiles(): Record<string, string> {
  return {
    "hooks/hooks.json": json({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                // biome-ignore lint/suspicious/noTemplateCurlyInString: expanded by Desktop, not JS
                command: 'cat "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.json"',
              },
            ],
          },
        ],
      },
    }),
    "hooks/session-start.json": json({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: MEMORY_AUTHORITY_LINE,
      },
    }),
  };
}

// Changes only when the hook does, so an Ocean upgrade alone never asks for the password again.
function contentVersion(): string {
  const hash = createHash("sha256");
  for (const [name, text] of Object.entries(hookFiles()))
    hash.update(`${name}\0${text}\0`);
  return `1.0.0-${hash.digest("hex").slice(0, 12)}`;
}

// The plugin's files, by path inside the plugin folder.
export function desktopPluginFiles(
  version = contentVersion(),
): Record<string, string> {
  return {
    ".claude-plugin/plugin.json": json({
      name: DESKTOP_PLUGIN_NAME,
      version,
      description:
        "Ocean is your single memory: every Claude Desktop session starts knowing it, and asks Ocean before its own memory.",
      author: { name: "Ocean" },
      homepage: "https://github.com/amoree-code/ocean",
      installationPreference: "required",
    }),
    "version.json": json({ version }),
    ...hookFiles(),
  };
}

// A stored (uncompressed) zip with a fixed timestamp, so the same files give the same bytes.
// Folder entries precede their files, as `zip` writes them.
export function zipStored(files: Record<string, string>): Buffer {
  const entries: [string, Buffer][] = [];
  const folders = new Set<string>();
  for (const [name, text] of Object.entries(files)) {
    const parts = name.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const folder = `${parts.slice(0, depth).join("/")}/`;
      if (!folders.has(folder)) {
        folders.add(folder);
        entries.push([folder, Buffer.alloc(0)]);
      }
    }
    entries.push([name, Buffer.from(text, "utf8")]);
  }
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(0, 30); // extra and comment lengths
    central.writeUInt32LE(0, 34); // disk start and internal attributes
    const mode = name.endsWith("/") ? 0o40755 : 0o100644;
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// True when the folder Desktop reads holds exactly this plugin. Readable without admin rights.
export function desktopPluginInstalled(
  orgDir = desktopOrgPluginsDir(),
): boolean {
  if (!orgDir) return false;
  const target = path.join(orgDir, DESKTOP_PLUGIN_NAME);
  try {
    return Object.entries(desktopPluginFiles()).every(
      ([name, text]) => readFileSync(path.join(target, name), "utf8") === text,
    );
  } catch {
    return false;
  }
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;

// Copies the staged plugin into the admin-only folder behind the system's own password prompt.
function elevatedCopy(
  staging: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const orgDir = path.dirname(target);
  if (platform === "darwin") {
    const sh = `mkdir -p ${shellQuote(orgDir)} && rm -rf ${shellQuote(target)} && cp -R ${shellQuote(staging)} ${shellQuote(target)}`;
    const escaped = sh.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    execFileSync(
      "osascript",
      [
        "-e",
        `do shell script "${escaped}" with prompt "Ocean installs its Claude Desktop plugin." with administrator privileges`,
      ],
      { stdio: "ignore" },
    );
    return;
  }
  if (platform === "win32") {
    const inner = `New-Item -ItemType Directory -Force -Path ${psQuote(orgDir)} | Out-Null; if (Test-Path ${psQuote(target)}) { Remove-Item -Recurse -Force ${psQuote(target)} }; Copy-Item -Recurse ${psQuote(staging)} ${psQuote(target)}`;
    const encoded = Buffer.from(inner, "utf16le").toString("base64");
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'`,
      ],
      { stdio: "ignore" },
    );
    return;
  }
  throw new Error(`no elevated copy on ${platform}`);
}

async function directCopy(staging: string, target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await cp(staging, target, { recursive: true });
}

export type DesktopPluginResult =
  | { status: "current" | "installed"; dir: string; next: string }
  | { status: "manual"; file: string; reason: string; next: string };

const NEXT_SYNC =
  "Claude Desktop installs it at its next launch or new session; nothing to upload";

// Puts the plugin where Desktop installs it by itself. Only when that folder does not exist on
// this platform, or the admin prompt is declined, does it fall back to a zip to upload.
export async function installDesktopPlugin(
  options: {
    orgDir?: string | undefined;
    staging?: string;
    copy?: (staging: string, target: string) => Promise<void>;
    elevate?: (staging: string, target: string) => void;
  } = {},
): Promise<DesktopPluginResult> {
  const orgDir = "orgDir" in options ? options.orgDir : desktopOrgPluginsDir();
  const manual = async (reason: string): Promise<DesktopPluginResult> => {
    const file = desktopPluginFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, zipStored(desktopPluginFiles()));
    return { status: "manual", file, reason, next: DESKTOP_PLUGIN_UPLOAD };
  };
  if (!orgDir)
    return manual(
      `Claude Desktop reads no organization plugins folder on ${process.platform}`,
    );
  const target = path.join(orgDir, DESKTOP_PLUGIN_NAME);
  if (desktopPluginInstalled(orgDir))
    return { status: "current", dir: target, next: "" };

  const staging = path.join(
    options.staging ?? desktopPluginStaging(),
    DESKTOP_PLUGIN_NAME,
  );
  await rm(staging, { recursive: true, force: true });
  for (const [name, text] of Object.entries(desktopPluginFiles())) {
    await mkdir(path.dirname(path.join(staging, name)), { recursive: true });
    await writeFile(path.join(staging, name), text);
  }
  try {
    await (options.copy ?? directCopy)(staging, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw error;
    try {
      (options.elevate ?? elevatedCopy)(staging, target);
    } catch {
      return manual("the admin password prompt was declined or failed");
    }
  }
  if (!desktopPluginInstalled(orgDir))
    return manual(`the plugin did not land in ${target}`);
  return { status: "installed", dir: target, next: NEXT_SYNC };
}
