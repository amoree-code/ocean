import { execFile as execFileCallback } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { atomicWrite } from "../../fs-utils.js";
import { enginePath, oceanEnv, oceanPath, SYSTEM_DIR } from "../../paths.js";
import {
  builtInProviderRecords,
  loadProviderRegistry,
  type ProviderRecord,
  resolveOriginalExecutable,
  saveProviderRegistry,
} from "../providers/provider-registry.js";

const execFile = promisify(execFileCallback);

const CLI_WRAPPER_NAMES = ["ocean"] as const;
const DESKTOP_WRAPPER_PROVIDERS = ["claude"] as const;

export function shimDirectory(): string {
  return oceanPath(SYSTEM_DIR, "runtime", "shims");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function wrapperPath(command: string): string {
  return process.platform === "win32"
    ? path.join(shimDirectory(), `${command}.cmd`)
    : path.join(shimDirectory(), command);
}

// A provider wrapper never takes the provider's own name: a same-name shim shadows the native
// binary and its behaviour then depends on PATH order and on which shell is running (T-266).
// Clients reach Ocean through their native hooks; `ocean-<command>` is the explicit way in.
export function providerWrapperName(command: string): string {
  return `ocean-${command}`;
}

export function providerWrapperPath(command: string): string {
  return wrapperPath(providerWrapperName(command));
}

// Names Ocean may own in the shim directory; anything else there can shadow a real command.
function isNamespacedShim(name: string): boolean {
  const base = name.replace(/\.cmd$/i, "");
  return (
    (CLI_WRAPPER_NAMES as readonly string[]).includes(base) ||
    base.startsWith("ocean-") ||
    DESKTOP_WRAPPER_PROVIDERS.some((provider) => base === `${provider}-vscode`)
  );
}

// Every provider wrapper Ocean has written (posix and .cmd) sets OCEAN_SHIM_DIR and calls
// intercept; a user's own script that merely calls `ocean intercept` does not set the variable.
function isOceanInterceptWrapper(contents: string): boolean {
  return (
    contents.includes("OCEAN_SHIM_DIR=") &&
    contents.includes(" intercept --client ")
  );
}

// The interpreter recorded at sync time, or `node` from PATH once that one is gone
// (an fnm/nvm upgrade removes the old version's directory).
function posixNode(): string {
  return `node=${shellQuote(process.execPath)}\n[ -x "$node" ] || node=node\n`;
}

function windowsNode(): string {
  return `set "node=${process.execPath}"\r\nif not exist "%node%" set "node=node"\r\n`;
}

export function desktopWrapperPath(provider = "claude"): string {
  return wrapperPath(`${provider}-vscode`);
}

function wrapperContents(provider: ProviderRecord): string {
  const entry = shellQuote(enginePath("dist", "main.js"));
  if (process.platform === "win32") {
    return `@echo off\r\nset "OCEAN_SHIM_DIR=${shimDirectory()}"\r\n${windowsNode()}"%node%" "${enginePath("dist", "main.js")}" intercept --client "${provider.id}" -- %*\r\n`;
  }
  return `#!/bin/sh\nexport OCEAN_SHIM_DIR=${shellQuote(shimDirectory())}\n${posixNode()}exec "$node" ${entry} intercept --client ${shellQuote(provider.id)} -- "$@"\n`;
}

function cliWrapperContents(): string {
  if (process.platform === "win32") {
    return `@echo off\r\n${windowsNode()}"%node%" "${enginePath("dist", "main.js")}" %*\r\n`;
  }
  return `#!/bin/sh\n${posixNode()}exec "$node" ${shellQuote(enginePath("dist", "main.js"))} "$@"\n`;
}

function desktopWrapperContents(provider: string): string {
  if (process.platform === "win32") {
    return `@echo off\r\nif "%~1"=="" exit /b 64\r\nset "native=%~1"\r\nshift\r\n${windowsNode()}"%node%" "${enginePath("dist", "main.js")}" intercept --client "${provider}" --executable "%native%" -- %*\r\n`;
  }
  return `#!/bin/sh
if [ "$#" -lt 1 ]; then
  echo "Ocean desktop wrapper requires the native ${provider} executable path" >&2
  exit 64
fi
native="$1"
shift
${posixNode()}exec "$node" ${shellQuote(enginePath("dist", "main.js"))} intercept --client ${shellQuote(provider)} --executable "$native" -- "$@"
`;
}

export async function syncProviderWrappers(): Promise<{
  providers: ProviderRecord[];
  directory: string;
}> {
  const providers = loadProviderRegistry();
  await mkdir(shimDirectory(), { recursive: true });
  for (const name of CLI_WRAPPER_NAMES) {
    const cliWrapper = wrapperPath(name);
    await writeFile(cliWrapper, cliWrapperContents());
    if (process.platform !== "win32") await chmod(cliWrapper, 0o755);
  }
  for (const provider of providers) {
    const file = providerWrapperPath(provider.command);
    await writeFile(file, wrapperContents(provider));
    if (process.platform !== "win32") await chmod(file, 0o755);
  }
  for (const provider of DESKTOP_WRAPPER_PROVIDERS) {
    const desktopWrapper = desktopWrapperPath(provider);
    await writeFile(desktopWrapper, desktopWrapperContents(provider));
    if (process.platform !== "win32") await chmod(desktopWrapper, 0o755);
  }
  await removeLegacyShims();
  await saveProviderRegistry(providers);
  return { providers, directory: shimDirectory() };
}

// Removes same-name shims left by earlier syncs, including ones for providers no longer
// registered, but only files Ocean wrote: anything else is the user's, and doctor reports it.
async function removeLegacyShims(): Promise<void> {
  for (const name of await readdir(shimDirectory())) {
    if (name.startsWith(".") || isNamespacedShim(name)) continue;
    await removeLegacyShim(path.join(shimDirectory(), name));
  }
}

async function removeLegacyShim(file: string): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (isOceanInterceptWrapper(contents)) await rm(file, { force: true });
}

export async function registerProvider(
  id: string,
  command = id,
): Promise<ProviderRecord> {
  if (!/^[a-zA-Z0-9._-]+$/.test(id) || !/^[a-zA-Z0-9._-]+$/.test(command)) {
    throw new Error(
      "Provider id and command may contain only letters, numbers, dot, underscore, and hyphen",
    );
  }
  const providers = loadProviderRegistry().filter(
    (provider) => provider.id !== id,
  );
  const provider: ProviderRecord = {
    id,
    command,
    interactive: true,
    headless: true,
  };
  await saveProviderRegistry([...providers, provider]);
  await syncProviderWrappers();
  return provider;
}

export async function setProviderEnabled(
  id: string,
  enabled: boolean,
): Promise<ProviderRecord> {
  const providers = loadProviderRegistry();
  const provider = providers.find(
    (candidate) => candidate.id === id || candidate.command === id,
  );
  if (!provider) throw new Error(`Provider is not registered: ${id}`);
  const updated: ProviderRecord = { ...provider, enabled };
  await saveProviderRegistry(
    providers.map((candidate) =>
      candidate.id === provider.id ? updated : candidate,
    ),
  );
  return updated;
}

export async function removeProvider(id: string): Promise<ProviderRecord> {
  const providers = loadProviderRegistry();
  const provider = providers.find(
    (candidate) => candidate.id === id || candidate.command === id,
  );
  if (!provider) throw new Error(`Provider is not registered: ${id}`);
  if (
    builtInProviderRecords().some((candidate) => candidate.id === provider.id)
  ) {
    throw new Error(
      `Built-in provider remains registered; use its package manager to remove: ${provider.id}`,
    );
  }
  await rm(providerWrapperPath(provider.command), { force: true });
  await removeLegacyShim(wrapperPath(provider.command));
  await saveProviderRegistry(
    providers.filter((candidate) => candidate.id !== provider.id),
  );
  return provider;
}

export function shellKind(
  parentCommand: string,
  loginShell: string,
): "fish" | "posix" {
  const parent = path.basename(parentCommand.trim().split(/\s+/, 1)[0] ?? "");
  if (parent === "fish") return "fish";
  if (["ash", "bash", "dash", "ksh", "sh", "zsh"].includes(parent))
    return "posix";
  return path.basename(loginShell) === "fish" ? "fish" : "posix";
}

async function currentShellName(): Promise<string> {
  if (process.platform === "win32") return "powershell";
  try {
    const { stdout } = await execFile("ps", [
      "-p",
      String(process.ppid),
      "-o",
      "comm=",
    ]);
    const parent = path.basename(stdout.trim().split(/\s+/, 1)[0] ?? "");
    if (["ash", "bash", "dash", "fish", "ksh", "sh", "zsh"].includes(parent))
      return parent;
  } catch {
    // Fall through to the configured login shell.
  }
  return path.basename(process.env.SHELL ?? "");
}

async function currentShellKind(): Promise<"fish" | "posix"> {
  return (await currentShellName()) === "fish" ? "fish" : "posix";
}

// Appended, once: the shim directory holds only Ocean's own names, so its PATH position no
// longer decides anything, and re-sourcing a profile never grows PATH.
export function shellPathLine(
  kind: "fish" | "posix" | "powershell",
  directory: string,
): string {
  if (kind === "powershell")
    return `if (-not (($env:Path -split ';') -contains "${directory}")) { $env:Path = "$env:Path;${directory}" }`;
  const quoted = shellQuote(directory);
  // --path edits $PATH itself; without it fish puts fish_user_paths in front of the system dirs.
  if (kind === "fish") return `fish_add_path --append --path ${quoted}`;
  return `case ":$PATH:" in *:${quoted}:*) ;; *) export PATH="$PATH":${quoted} ;; esac`;
}

export async function installShellPath(): Promise<string> {
  const kind =
    process.platform === "win32" ? "powershell" : await currentShellKind();
  return shellPathLine(kind, shimDirectory());
}

async function shellProfilePath(): Promise<string> {
  const home = os.homedir();
  if (process.platform === "win32")
    return (
      oceanEnv("SHELL_PROFILE") ??
      path.join(
        home,
        "Documents",
        "PowerShell",
        "Microsoft.PowerShell_profile.ps1",
      )
    );
  const profile = oceanEnv("SHELL_PROFILE");
  if (profile) return profile;
  const shell = await currentShellName();
  if (shell === "fish")
    return path.join(home, ".config", "fish", "config.fish");
  if (shell === "zsh") return path.join(home, ".zshrc");
  if (shell === "bash") return path.join(home, ".bashrc");
  return path.join(home, ".profile");
}

const BLOCK_BEGIN = /^# >>> (ocean) interception >>>$/;

function withoutEol(line: string): string {
  return line.replace(/\r?\n$/, "");
}

// Removes every managed interception block and nothing else:
// all other lines keep their exact bytes and line endings. Only the single blank separator the
// installer puts above its block goes with it. A begin marker without a matching end marker is
// left alone rather than guessed at.
function stripInterceptionBlocks(text: string): string {
  const lines = text.split(/(?<=\n)/);
  const kept: string[] = [];
  // Once a name has no end marker after some position it has none after any later one, so
  // repeated unterminated begin markers cost one scan, not one scan each.
  const noEndFor = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const begin = BLOCK_BEGIN.exec(withoutEol(lines[index]));
    if (begin && !noEndFor.has(begin[1])) {
      const end = `# <<< ${begin[1]} interception <<<`;
      const close = lines.findIndex(
        (line, at) => at > index && withoutEol(line) === end,
      );
      if (close < 0) noEndFor.add(begin[1]);
      if (close >= 0) {
        if (kept.length && withoutEol(kept[kept.length - 1]).trim() === "")
          kept.pop();
        index = close;
        continue;
      }
    }
    kept.push(lines[index]);
  }
  return kept.join("");
}

export async function installShellIntegration(): Promise<string> {
  const file = await shellProfilePath();
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    /* new profile */
  }
  const line = await installShellPath();
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  let rest = stripInterceptionBlocks(existing);
  if (rest && !rest.endsWith("\n")) rest += eol;
  const block = `${["# >>> ocean interception >>>", line, "# <<< ocean interception <<<"].join(eol)}${eol}`;
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, rest ? `${rest}${eol}${block}` : block);
  return file;
}

export async function wrapperDoctor(commandPath?: string): Promise<string[]> {
  const findings: string[] = [];
  const providers = loadProviderRegistry();
  for (const name of CLI_WRAPPER_NAMES) {
    try {
      const contents = await readFile(wrapperPath(name), "utf8");
      if (!contents.includes(enginePath("dist", "main.js")))
        findings.push(
          `${name}: CLI wrapper is stale or does not route through Ocean; run: ocean doctor --fix`,
        );
    } catch {
      findings.push(
        `${name}: CLI wrapper is missing at ${wrapperPath(name)}; run: ocean doctor --fix`,
      );
    }
  }
  for (const provider of providers) {
    try {
      const contents = await readFile(
        providerWrapperPath(provider.command),
        "utf8",
      );
      if (
        !contents.includes(`intercept --client '${provider.id}'`) &&
        !contents.includes(`intercept --client "${provider.id}"`)
      ) {
        findings.push(
          `${provider.id}: wrapper is stale or does not route through Ocean`,
        );
      }
    } catch {
      findings.push(
        `${provider.id}: wrapper is missing at ${providerWrapperPath(provider.command)}`,
      );
    }
    try {
      resolveOriginalExecutable(provider.command);
    } catch (error) {
      findings.push(
        `${provider.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const currentPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => path.resolve(entry));
  if (!currentPath.includes(path.resolve(shimDirectory())))
    findings.push(`Ocean shim directory is not on PATH: ${shimDirectory()}`);
  let names: string[] = [];
  try {
    names = await readdir(shimDirectory());
  } catch {
    /* reported above as missing wrappers */
  }
  const strays = names.filter(
    (entry) => !entry.startsWith(".") && !isNamespacedShim(entry),
  );
  for (const name of strays.sort())
    findings.push(
      `${name}: ${path.join(shimDirectory(), name)} can shadow the native ${name} command; run: ocean client sync, or remove it if it is not Ocean's`,
    );
  const bypass = commandPath ? absolutePathBypassFinding(commandPath) : null;
  if (bypass) findings.push(bypass);
  return findings;
}

export function absolutePathBypassFinding(commandPath: string): string | null {
  if (!path.isAbsolute(commandPath)) return null;
  const resolved = path.resolve(commandPath);
  if (resolved.startsWith(`${path.resolve(shimDirectory())}${path.sep}`))
    return null;
  const command = path.basename(resolved).replace(/\.(cmd|exe|bat)$/i, "");
  const provider = loadProviderRegistry().find(
    (candidate) => candidate.command === command,
  );
  // Running a provider natively is the normal route since T-266, but it reaches Ocean only
  // through a registered native hook; say so instead of calling it a misuse.
  if (provider)
    return `NATIVE_ENTRY: ${provider.id} at ${resolved} reaches Ocean only through its native hook; ${providerWrapperName(provider.command)} routes it through Ocean`;
  return `BYPASS_DETECTED: absolute path is outside Ocean and is not a registered provider: ${resolved}`;
}

export async function wrapperStatus(): Promise<
  Array<
    ProviderRecord & {
      wrapper: string;
      installed: boolean;
      realExecutable: string | null;
      entryPoint: "terminal-shim";
      controlLevel: "observed";
    }
  >
> {
  const providers = loadProviderRegistry();
  return Promise.all(
    providers.map(async (provider) => {
      let realExecutable: string | null = null;
      try {
        realExecutable = resolveOriginalExecutable(provider.command);
      } catch {
        /* reported by doctor */
      }
      let installed = true;
      try {
        await access(providerWrapperPath(provider.command));
      } catch {
        installed = false;
      }
      return {
        ...provider,
        enabled: provider.enabled !== false,
        wrapper: providerWrapperPath(provider.command),
        installed,
        realExecutable,
        entryPoint: "terminal-shim",
        controlLevel: "observed",
      };
    }),
  );
}
