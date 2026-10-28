import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWrite } from "@ocean/core/shared/fs-utils.js";
import { liveEngineEntry, repoRoot } from "@ocean/core/shared/paths.js";

// Client configs that may launch Ocean by an absolute path into the kernel (an MCP server entry).
// When the engine's entry moved (packages/core → packages/harness), an entry written earlier kept
// the old path and the client's Ocean server failed to start without a word (T-293). Only the
// engine entry's former locations are rewritten, and only while they no longer exist — another
// kernel package's server that is merely not built yet is never touched; the files are otherwise
// left byte for byte.

// Where the engine's `dist/main.js` lived before it moved to packages/harness.
const FORMER_ENGINE_PACKAGES = ["core"];

const CLIENT_CONFIGS = [
  ".gemini/settings.json",
  ".hermes/config.yaml",
  ".codex/config.toml",
  ".claude.json",
  ".cursor/mcp.json",
];

export type EngineEntryRepair = {
  file: string;
  status: "updated" | "current" | "missing" | "unreadable";
  replaced: string[];
};

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function repairEngineEntries(
  home = os.homedir(),
): Promise<EngineEntryRepair[]> {
  const entry = liveEngineEntry();
  const results: EngineEntryRepair[] = [];
  // Without a built entry there is nothing correct to point at.
  if (!existsSync(entry)) return results;
  const stale = new RegExp(
    FORMER_ENGINE_PACKAGES.map((name) =>
      escape(path.join(repoRoot(), "packages", name, "dist", "main.js")),
    ).join("|"),
    "g",
  );
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
    const replaced = [
      ...new Set(
        [...text.matchAll(stale)]
          .map((match) => match[0])
          .filter((found) => found !== entry && !existsSync(found)),
      ),
    ];
    if (!replaced.length) {
      results.push({ file: display, status: "current", replaced });
      continue;
    }
    let next = text;
    for (const found of replaced) next = next.replaceAll(found, entry);
    await atomicWrite(file, next);
    results.push({ file: display, status: "updated", replaced });
  }
  return results;
}
