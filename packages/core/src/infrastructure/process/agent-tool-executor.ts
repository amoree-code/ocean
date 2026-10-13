import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "../../domain/redaction/redaction.js";
import type { ToolArguments, ToolName } from "../../domain/runs/agent-tools.js";
import type { ExecutionPlan } from "../../domain/runs/execution-plan.js";
import { atomicWrite } from "../../fs-utils.js";
import { resolveWithin } from "../../paths.js";
import { resolveOriginalExecutable } from "../providers/provider-registry.js";

// Executes one already-validated tool call for a tool-loop run (T-245 Phase 6). Everything
// a file tool touches is bounded to the plan's allowed paths under its cwd, by real path, and
// never to credential-bearing files: what a tool reads is sent to a third-party API.

export const MAX_READ_BYTES = 64 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_COMMAND_OUTPUT = 64 * 1024;
const MAX_COMMAND_MS = 60_000;

// A policy refusal, as opposed to a tool that ran and failed. The loop records it as
// `tool_denied` by this name.
export class ToolDenied extends Error {
  override name = "ToolDenied";
}

// Files that hold credentials or repository internals: never read, listed as denied, never
// written. A .git directory can hold a token in a remote URL.
function isSensitive(relative: string): boolean {
  return relative
    .split(/[\\/]/)
    .some(
      (segment) =>
        segment === ".git" ||
        /^\.env(\..*)?$/i.test(segment) ||
        /^id_[a-z0-9]+(\.pub)?$/i.test(segment) ||
        /\.(pem|key|p12|pfx|keystore)$/i.test(segment) ||
        /^\.(npmrc|netrc|pypirc)$/i.test(segment),
    );
}

// The target, by real path, inside one of the plan's allowed paths (relative to its cwd).
// resolveWithin rejects lexical escapes and symlinks that lead outside a root.
function resolveTarget(plan: ExecutionPlan, requested: string): string {
  if (path.isAbsolute(requested))
    throw new ToolDenied("path must be relative to the working directory");
  if (isSensitive(path.normalize(requested)))
    throw new ToolDenied("path is a credential or repository-internal file");
  for (const allowed of plan.sandbox.allowedPaths) {
    let root: string;
    try {
      root = resolveWithin(plan.cwd, allowed);
    } catch {
      continue;
    }
    const target = path.resolve(plan.cwd, requested);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    try {
      return resolveWithin(root, relative);
    } catch {
      throw new ToolDenied("path escapes the allowed paths");
    }
  }
  throw new ToolDenied("path is outside the allowed paths");
}

// Credentials are removed from a command's environment: its output goes to the provider.
function commandEnv(plan: ExecutionPlan): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!/(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key))
      env[key] = value;
  return { ...env, ...plan.childEnv };
}

function runCommand(
  plan: ExecutionPlan,
  args: ToolArguments["run_command"],
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveOriginalExecutable(args.command), args.args, {
      cwd: plan.cwd,
      env: commandEnv(plan),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      signal,
    });
    let output = "";
    let truncated = false;
    const collect = (chunk: Buffer) => {
      if (output.length >= MAX_COMMAND_OUTPUT) {
        truncated = true;
        return;
      }
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), MAX_COMMAND_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, killed) => {
      clearTimeout(timer);
      resolve(
        `exit ${code ?? killed}\n${redactSecrets(output.slice(0, MAX_COMMAND_OUTPUT))}${truncated ? "\n[output truncated]" : ""}`,
      );
    });
  });
}

export async function executeAgentTool(
  plan: ExecutionPlan,
  name: ToolName,
  args: ToolArguments[ToolName],
  signal: AbortSignal,
): Promise<string> {
  if (name === "read_file") {
    const target = resolveTarget(
      plan,
      (args as ToolArguments["read_file"]).path,
    );
    const info = await stat(target);
    if (!info.isFile()) throw new ToolDenied("not a file");
    if (info.size > MAX_READ_BYTES)
      throw new ToolDenied(`file exceeds ${MAX_READ_BYTES} bytes`);
    return readFile(target, "utf8");
  }
  if (name === "list_directory") {
    const target = resolveTarget(
      plan,
      (args as ToolArguments["list_directory"]).path,
    );
    const entries = await readdir(target, { withFileTypes: true });
    return entries
      .filter((entry) => !isSensitive(entry.name))
      .slice(0, MAX_LIST_ENTRIES)
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort()
      .join("\n");
  }
  if (name === "write_file") {
    const { path: requested, content } = args as ToolArguments["write_file"];
    // The parent must resolve inside the allowed paths before anything is created.
    resolveTarget(plan, path.dirname(requested) || ".");
    const target = resolveTarget(plan, requested);
    await mkdir(path.dirname(target), { recursive: true });
    await atomicWrite(target, content);
    return `wrote ${Buffer.byteLength(content)} bytes to ${requested}`;
  }
  return runCommand(plan, args as ToolArguments["run_command"], signal);
}
