import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32 } from "node:zlib";
import { MEMORY_AUTHORITY_LINE } from "@ocean/core/domain/mcp/memory-contract.js";
import { enginePath, oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";

// Claude Desktop's chat has no hook setting Ocean can write, and its own memory prompt outranks
// the MCP server's instructions (T-328: asked alone "where is my memory saved?", chat named
// Anthropic's store). A plugin the user uploads runs its SessionStart hook in chat, Cowork and
// Code sessions alike (claude.com/docs/third-party/claude-desktop/extensions), so the plugin
// carries the authority line into context before the first turn.
//
// Static on purpose: chat hooks run sandboxed (the probe's log write never landed on the host),
// so the hook cannot reach the `ocean` engine, and in Code sessions Ocean's own hook already
// gives the start line — calling the engine here would issue it twice. Desktop keeps uploaded
// plugins in the account, not on disk, so Ocean cannot see whether one is installed.

export const DESKTOP_PLUGIN_NAME = "ocean";

export function desktopPluginFile(): string {
  return oceanPath(SYSTEM_DIR, "state", "clients", "ocean-desktop-plugin.zip");
}

export const DESKTOP_PLUGIN_UPLOAD =
  "Claude Desktop → Customize → Plugins → + → Upload plugin, choose this file, then quit Claude (⌘Q) and reopen it";

function engineVersion(): string {
  const manifest = JSON.parse(readFileSync(enginePath("package.json"), "utf8"));
  return String(manifest.version);
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// The plugin's files, by path inside the zip. Pure apart from the engine version.
export function desktopPluginFiles(
  version = engineVersion(),
): Record<string, string> {
  return {
    ".claude-plugin/plugin.json": json({
      name: DESKTOP_PLUGIN_NAME,
      version,
      description:
        "Ocean is your single memory: every Claude Desktop session starts knowing it, and asks Ocean before its own memory.",
      author: { name: "Ocean" },
      homepage: "https://github.com/amoree-code/ocean",
    }),
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

export type DesktopPluginResult = { file: string; next: string };

// Writes the plugin zip where `ocean clients apply` and `ocean clients desktop-plugin` say.
// Uploading it stays the user's step: Desktop has no file or API Ocean may write for it.
export async function writeDesktopPlugin(
  file = desktopPluginFile(),
): Promise<DesktopPluginResult> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, zipStored(desktopPluginFiles()));
  return { file, next: DESKTOP_PLUGIN_UPLOAD };
}
