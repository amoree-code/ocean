import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWrite } from "@ocean/core/shared/fs-utils.js";
import {
  liveEngineEntry,
  releaseWorkspace,
  repoRoot,
} from "@ocean/core/shared/paths.js";

// Client configs that may launch Ocean by an absolute path into the kernel (an MCP server entry).
// When the engine's entry moved (packages/core → packages/harness), an entry written earlier kept
// the old path and the client's Ocean server failed to start without a word (T-293). Only the
// engine entry's former locations are rewritten, and only while they no longer exist — another
// kernel package's server that is merely not built yet is never touched; the files are otherwise
// left byte for byte. Run from a release (T-294), the checkout's own engine entry is repointed
// to `current` too, even though it exists — otherwise every MCP session keeps running whatever
// branch the checkout last built.

// Where the engine's `dist/main.js` lived before it moved to packages/harness.
const FORMER_ENGINE_PACKAGES = ["core"];

const CLIENT_CONFIGS = [
  ".gemini/settings.json",
  ".hermes/config.yaml",
  ".codex/config.toml",
  ".claude.json",
  ".cursor/mcp.json",
  ".gemini/antigravity/mcp_config.json",
  // Claude Desktop: macOS, then Windows.
  "Library/Application Support/Claude/claude_desktop_config.json",
  "AppData/Roaming/Claude/claude_desktop_config.json",
];

export type EngineEntryRepair = {
  file: string;
  status: "updated" | "current" | "missing" | "unreadable";
  replaced: string[];
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A JSON config stores a Windows path with every backslash escaped, so a path is searched in
// both spellings and replaced in the spelling it was found in. On POSIX the two are the same.
function asJson(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

export async function repairEngineEntries(
  home = os.homedir(),
): Promise<EngineEntryRepair[]> {
  const entry = liveEngineEntry();
  const results: EngineEntryRepair[] = [];
  // Without a built entry there is nothing correct to point at.
  if (!existsSync(entry)) return results;
  const checkoutEntry = releaseWorkspace()
    ? path.join(repoRoot(), "packages", "harness", "dist", "main.js")
    : null;
  const targets = [
    ...FORMER_ENGINE_PACKAGES.map((name) =>
      path.join(repoRoot(), "packages", name, "dist", "main.js"),
    ),
    ...(checkoutEntry ? [checkoutEntry] : []),
  ];
  const stale = new RegExp(
    [...new Set(targets.flatMap((target) => [target, asJson(target)]))]
      .map(escapeRegExp)
      .join("|"),
    "g",
  );
  const pathOf = (found: string) =>
    targets.find((target) => target === found || asJson(target) === found) ??
    found;
  for (const relative of CLIENT_CONFIGS) {
    const file = path.join(home, relative);
    const display = `~/${relative}`;
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      // A config that exists but cannot be read is said so, never passed off as absent.
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      results.push({
        file: display,
        status: missing ? "missing" : "unreadable",
        replaced: [],
      });
      continue;
    }
    const hits = [
      ...new Set([...text.matchAll(stale)].map((match) => match[0])),
    ].filter((found) => {
      const target = pathOf(found);
      return (
        target !== entry && (target === checkoutEntry || !existsSync(target))
      );
    });
    const replaced = [...new Set(hits.map(pathOf))];
    if (!replaced.length) {
      results.push({ file: display, status: "current", replaced });
      continue;
    }
    let next = text;
    for (const found of hits)
      next = next.replaceAll(
        found,
        found === pathOf(found) ? entry : asJson(entry),
      );
    await atomicWrite(file, next);
    results.push({ file: display, status: "updated", replaced });
  }
  return results;
}
