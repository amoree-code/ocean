import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WrapperManagerPort } from "@ocean/core/domain/ports/platform-ports.js";

function defaultClaudeCodeSettingsPath(): string {
  if (process.platform === "darwin")
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Code",
      "User",
      "settings.json",
    );
  if (process.platform === "win32")
    return path.join(
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
      "Code",
      "User",
      "settings.json",
    );
  return path.join(os.homedir(), ".config", "Code", "User", "settings.json");
}

const WRAPPER_KEY = "claudeCode.claudeProcessWrapper";

// VS Code settings are JSONC: comments and trailing commas are legal.
function stripJsonc(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"')
        j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else {
      if (ch === "}" || ch === "]") out = out.replace(/,\s*$/, "");
      out += ch;
      i++;
    }
  }
  return out;
}

function parseSettings(source: string): {
  settings: Record<string, unknown>;
  strict: boolean;
} {
  try {
    return {
      settings: JSON.parse(source) as Record<string, unknown>,
      strict: true,
    };
  } catch {
    return {
      settings: JSON.parse(stripJsonc(source)) as Record<string, unknown>,
      strict: false,
    };
  }
}

// Edit the key in place so a JSONC file keeps its comments and formatting.
function setWrapperKey(source: string, wrapper: string): string {
  const entry = `"${WRAPPER_KEY}": ${JSON.stringify(wrapper)}`;
  const existing = new RegExp(`"${WRAPPER_KEY.replace(".", "\\.")}"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"`);
  if (existing.test(source)) return source.replace(existing, () => entry);
  const open = source.indexOf("{");
  const rest = stripJsonc(source.slice(open + 1)).trim();
  return `${source.slice(0, open + 1)}\n  ${entry}${rest === "}" ? "" : ","}${source.slice(open + 1)}`;
}

export async function configureClaudeCodeWrapper(
  wrapperManager: WrapperManagerPort,
  settingsPath = defaultClaudeCodeSettingsPath(),
  apply = false,
): Promise<{
  settingsPath: string;
  wrapper: string;
  apply: boolean;
  changed: boolean;
  backup: string | null;
}> {
  const wrapper = wrapperManager.desktopWrapperPath("claude");
  let source = "{}\n";
  try {
    source = await readFile(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let parsed: ReturnType<typeof parseSettings>;
  try {
    parsed = parseSettings(source);
  } catch {
    throw new Error(
      `Claude Code settings are not valid JSON or JSONC: ${settingsPath}`,
    );
  }
  const { settings, strict } = parsed;
  const updated = strict
    ? `${JSON.stringify({ ...settings, [WRAPPER_KEY]: wrapper }, null, 2)}\n`
    : setWrapperKey(source, wrapper);
  const changed = settings[WRAPPER_KEY] !== wrapper;
  if (!apply || !changed)
    return { settingsPath, wrapper, apply, changed, backup: null };

  await mkdir(path.dirname(settingsPath), { recursive: true });
  let backup: string | null = null;
  try {
    const metadata = await stat(settingsPath);
    backup = `${settingsPath}.ocean-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(settingsPath, backup);
    await writeFile(
      settingsPath,
      updated,
      "utf8",
    );
    await chmod(settingsPath, metadata.mode & 0o777);
  } catch (error) {
    if (backup) throw error;
    await writeFile(
      settingsPath,
      updated,
      "utf8",
    );
  }
  return { settingsPath, wrapper, apply, changed, backup };
}
