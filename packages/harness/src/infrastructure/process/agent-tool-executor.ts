import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { containsKnownSecret } from "@ocean/core/domain/redaction/redaction.js";
import type {
  ToolArguments,
  ToolName,
} from "@ocean/core/domain/runs/agent-tools.js";
import type { ExecutionPlan } from "@ocean/core/domain/runs/execution-plan.js";
import { atomicWrite } from "../../fs-utils.js";
import { realDeepestExisting, resolveWithin } from "../../paths.js";

// Executes one already-validated file tool call for a tool-loop run (T-245 Phase 6).
// Everything it touches is bounded to the plan's allowed paths under its cwd, judged and
// operated on by real path, and never a credential-bearing or repository-internal file:
// what a tool reads is sent to a third-party API.

export const MAX_READ_BYTES = 64 * 1024;
const MAX_LIST_ENTRIES = 500;

// A policy refusal, as opposed to a tool that ran and failed. The loop records it as
// `tool_denied` by this name.
export class ToolDenied extends Error {
  override name = "ToolDenied";
}

// Case-insensitive: the default macOS volume is, so ".Git" is ".git".
function isSensitive(relative: string): boolean {
  return relative
    .split(/[\\/]/)
    .some(
      (segment) =>
        /^\.git$/i.test(segment) ||
        /^\.env(\..*)?$/i.test(segment) ||
        /^\.envrc$/i.test(segment) ||
        /^id_[a-z0-9]+(\.pub)?$/i.test(segment) ||
        /\.(pem|key|p12|pfx|keystore|jks)$/i.test(segment) ||
        /^\.(npmrc|netrc|pypirc|htpasswd|pgpass|git-credentials)$/i.test(
          segment,
        ) ||
        /^(credentials|secrets?)(\.[a-z0-9]+)*$/i.test(segment) ||
        /\.tfstate(\.backup)?$/i.test(segment) ||
        /^\.(aws|ssh|gnupg|docker|kube)$/i.test(segment),
    );
}

// The real location of a requested path inside one of the plan's allowed paths. Both the
// requested name and the real location must pass the sensitivity check, so a symlink inside
// an allowed path cannot lead to .env or .git; resolveWithin rejects lexical escapes and
// symlinks that leave the root. Callers operate on the returned real path.
function resolveTarget(plan: ExecutionPlan, requested: string): string {
  if (path.isAbsolute(requested))
    throw new ToolDenied("path must be relative to the working directory");
  if (isSensitive(path.normalize(requested)))
    throw new ToolDenied("path is a credential or repository-internal file");
  const target = path.resolve(plan.cwd, requested);
  for (const allowed of plan.sandbox.allowedPaths) {
    let root: string;
    try {
      root = resolveWithin(plan.cwd, allowed);
    } catch {
      continue;
    }
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    try {
      resolveWithin(root, relative);
    } catch {
      throw new ToolDenied("path escapes the allowed paths");
    }
    const real = realDeepestExisting(target);
    if (isSensitive(path.relative(realDeepestExisting(root), real)))
      throw new ToolDenied(
        "path leads to a credential or repository-internal file",
      );
    return real;
  }
  throw new ToolDenied("path is outside the allowed paths");
}

export async function executeAgentTool(
  plan: ExecutionPlan,
  name: ToolName,
  args: ToolArguments[ToolName],
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
    const content = await readFile(target, "utf8");
    // Refused, not redacted: a redacted file edited and written back would be corrupted.
    if (containsKnownSecret(content))
      throw new ToolDenied("file appears to contain a credential");
    return content;
  }
  if (name === "list_directory") {
    const target = resolveTarget(
      plan,
      (args as ToolArguments["list_directory"]).path,
    );
    const entries = (await readdir(target, { withFileTypes: true }))
      .filter((entry) => !isSensitive(entry.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort();
    const shown = entries.slice(0, MAX_LIST_ENTRIES);
    return [
      ...shown,
      ...(entries.length > shown.length
        ? [`[${entries.length - shown.length} more entries not shown]`]
        : []),
    ].join("\n");
  }
  const { path: requested, content } = args as ToolArguments["write_file"];
  const target = resolveTarget(plan, requested);
  await mkdir(path.dirname(target), { recursive: true });
  await atomicWrite(target, content);
  return `wrote ${Buffer.byteLength(content)} bytes to ${requested}`;
}
