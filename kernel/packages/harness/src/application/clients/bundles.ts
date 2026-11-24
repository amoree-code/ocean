import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { enginePath } from "@ocean/core/shared/paths.js";
import { oceanServerEntry } from "./clients.js";
import type { ServerValue } from "./editors.js";
import { storedZip } from "./zip.js";

// One-click bundles (T-328 phase 4): Ocean as a Claude Desktop Extension (`Ocean.mcpb`, the MCPB
// manifest 0.3 format: name, icon, a node server Desktop runs with its own Node) and as a Claude
// plugin (`ocean.plugin`: `.claude-plugin/plugin.json` plus the core `ocean-memory` skill) for the
// account's Customize → Plugins upload, which loads in chat, Cowork and Claude Code.
//
// Neither carries Ocean itself. The extension's server is a launcher that starts the Ocean already
// installed on this machine (`ocean mcp serve`), so the memory stays local and updates with Ocean.
// The plugin carries no connector or hook: Desktop chat and Cowork already reach Ocean through
// its config entry, Claude Code through its own, and a second copy would show every tool twice.

export const DESKTOP_EXTENSION_FILE = "Ocean.mcpb";
export const CLAUDE_PLUGIN_FILE = "ocean.plugin";

const AUTHOR = {
  name: "AMEER ABDULKAREEM JABBAR LAMI",
  url: "https://github.com/amoree-code",
};
const REPOSITORY = "https://github.com/amoree-code/ocean";
const DESCRIPTION =
  "Your local memory for every AI client: projects, tasks, decisions and preferences, kept on your computer.";

export const DESKTOP_EXTENSION_STEPS = [
  `Double-click ${DESKTOP_EXTENSION_FILE}, or in Claude Desktop: Settings → Extensions → Advanced settings → Install Extension`,
  "Install, then make sure Ocean's toggle is on",
];

export const CLAUDE_PLUGIN_STEPS = [
  "In Claude: Customize → Plugins → Add → Upload plugin",
  `Pick ${CLAUDE_PLUGIN_FILE}; it reaches chat, Cowork and Claude Code under the name Ocean`,
  "Skills need Settings → Capabilities → Code execution on",
];

// The extension's server: starts the installed Ocean with the command baked in at build time
// and hands it stdio. Plain CommonJS so Desktop's bundled Node runs it with no package.json.
export const LAUNCHER = `"use strict";
// Ocean Desktop Extension launcher: starts the Ocean installed on this computer.
const { spawn } = require("node:child_process");
const env = { ...process.env };
const command = env.OCEAN_MCPB_COMMAND || "ocean";
let args = ["mcp", "serve"];
try {
  if (env.OCEAN_MCPB_ARGS) args = JSON.parse(env.OCEAN_MCPB_ARGS);
} catch {}
delete env.OCEAN_MCPB_COMMAND;
delete env.OCEAN_MCPB_ARGS;
const child = spawn(command, args, {
  env,
  stdio: "inherit",
  shell: process.platform === "win32" && command === "ocean",
});
child.on("error", (error) => {
  process.stderr.write(
    "Ocean: cannot start " + command + ": " + error.message +
      "\\nInstall Ocean and run \`ocean setup\`, then build the extension again with \`ocean clients bundles\`.\\n",
  );
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
`;

export function desktopExtensionManifest(
  version: string,
  entry: ServerValue = oceanServerEntry(),
): Record<string, unknown> {
  return {
    manifest_version: "0.3",
    name: "ocean",
    display_name: "Ocean",
    version,
    description: DESCRIPTION,
    long_description:
      "Ocean keeps one memory on your computer that every AI client shares. This extension connects Claude Desktop to the Ocean installed here: its tools search and read your notes, tasks and past decisions, and propose new facts for your review.",
    author: AUTHOR,
    repository: { type: "git", url: `${REPOSITORY}.git` },
    homepage: REPOSITORY,
    documentation: `${REPOSITORY}/blob/main/kernel/docs/mcp.md`,
    support: `${REPOSITORY}/issues`,
    icon: "icon.png",
    server: {
      type: "node",
      entry_point: "server/index.js",
      mcp_config: {
        command: "node",
        // MCPB fills ${__dirname} with the extension folder; it is not a JS template.
        // biome-ignore lint/suspicious/noTemplateCurlyInString: MCPB placeholder
        args: ["${__dirname}/server/index.js"],
        env: {
          OCEAN_MCPB_COMMAND: entry.command,
          OCEAN_MCPB_ARGS: JSON.stringify(entry.args ?? []),
        },
      },
    },
    tools_generated: true,
    keywords: ["memory", "knowledge", "local-first", "tasks", "notes"],
    license: "MIT",
    compatibility: { platforms: ["darwin", "win32", "linux"] },
  };
}

function coreSkill(): Buffer {
  return readFileSync(
    path.join(enginePath("skills"), "core", "ocean-memory", "SKILL.md"),
  );
}

const json = (value: unknown) =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

export function desktopExtension(
  version: string,
  entry: ServerValue = oceanServerEntry(),
): Buffer {
  return storedZip([
    ["manifest.json", json(desktopExtensionManifest(version, entry))],
    ["icon.png", oceanIcon()],
    ["server/", Buffer.alloc(0)],
    ["server/index.js", Buffer.from(LAUNCHER, "utf8")],
  ]);
}

export function claudePluginManifest(version: string): Record<string, unknown> {
  return {
    name: "ocean",
    version,
    description: DESCRIPTION,
    author: AUTHOR,
    homepage: REPOSITORY,
    repository: REPOSITORY,
    license: "MIT",
    keywords: ["memory", "knowledge", "local-first"],
  };
}

export function claudePlugin(version: string, skill = coreSkill()): Buffer {
  return storedZip([
    [".claude-plugin/", Buffer.alloc(0)],
    [".claude-plugin/plugin.json", json(claudePluginManifest(version))],
    ["skills/", Buffer.alloc(0)],
    ["skills/ocean-memory/", Buffer.alloc(0)],
    ["skills/ocean-memory/SKILL.md", skill],
  ]);
}

export type WrittenBundles = { extension: string; plugin: string };

export async function writeBundles(
  version: string,
  dir = path.join(os.homedir(), "Downloads"),
): Promise<WrittenBundles> {
  await mkdir(dir, { recursive: true });
  const extension = path.join(dir, DESKTOP_EXTENSION_FILE);
  const plugin = path.join(dir, CLAUDE_PLUGIN_FILE);
  await writeFile(extension, desktopExtension(version));
  await writeFile(plugin, claudePlugin(version));
  return { extension, plugin };
}

// True when Claude Desktop's own config already starts Ocean, so installing the extension too
// would give Desktop two Ocean servers.
export function desktopConfigHasOcean(
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): boolean {
  const base =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Claude")
      : platform === "win32"
        ? path.join(
            process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
            "Claude",
          )
        : path.join(home, ".config", "Claude");
  try {
    const config = JSON.parse(
      readFileSync(path.join(base, "claude_desktop_config.json"), "utf8"),
    ) as { mcpServers?: Record<string, unknown> };
    return Boolean(config.mcpServers?.ocean);
  } catch {
    return false;
  }
}

// Ocean's icon, drawn here so the repository carries no binary: a rounded square in a deep-blue
// to teal gradient with two white waves, as an RGBA PNG.
export function oceanIcon(size = 512): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const top = [11, 61, 145];
  const bottom = [15, 163, 177];
  const waves = [
    { y: 0.42, amp: 0.06, len: 0.5, phase: 0, width: 0.055, alpha: 1 },
    { y: 0.62, amp: 0.06, len: 0.5, phase: Math.PI, width: 0.055, alpha: 0.75 },
  ];
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      const x = px + 0.5;
      const y = py + 0.5;
      // Rounded-square coverage from the signed distance to its edge.
      const qx = Math.abs(x - size / 2) - (size / 2 - radius);
      const qy = Math.abs(y - size / 2) - (size / 2 - radius);
      const outside =
        Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
        Math.min(Math.max(qx, qy), 0) -
        radius;
      const cover = clamp(0.5 - outside);
      if (cover === 0) continue;
      const t = y / size;
      let rgb = top.map((c, i) => c + (bottom[i] - c) * t);
      for (const wave of waves) {
        const k = (2 * Math.PI) / (wave.len * size);
        const arg = k * x + wave.phase;
        const curve = (wave.y + wave.amp * Math.sin(arg)) * size;
        const slope = wave.amp * size * k * Math.cos(arg);
        const distance = Math.abs(y - curve) / Math.sqrt(1 + slope * slope);
        const ink =
          clamp((wave.width * size) / 2 - distance + 0.5) * wave.alpha;
        rgb = rgb.map((c) => c + (255 - c) * ink);
      }
      const at = (py * size + px) * 4;
      pixels[at] = Math.round(rgb[0]);
      pixels[at + 1] = Math.round(rgb[1]);
      pixels[at + 2] = Math.round(rgb[2]);
      pixels[at + 3] = Math.round(cover * 255);
    }
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let row = 0; row < size; row++)
    pixels.copy(
      rows,
      row * (size * 4 + 1) + 1,
      row * size * 4,
      (row + 1) * size * 4,
    );
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
