import { execFile as execFileCallback } from "node:child_process";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  isWorkspaceProject,
  projectOfTasksRoot,
  repoRoot,
  resolveWithin,
  workspaceTasksRoot,
} from "@ocean/core/shared/paths.js";
import {
  expandHome,
  hasControlCharacters,
  projectVerify,
  readProjectManifest,
} from "@ocean/core/shared/project-resolution.js";

const execFile = promisify(execFileCallback);

// Only commands whose first token is on this list are ever executed by the
// verifier — including every link of a `&&`/`||`/`;`/`|` chain, since each
// link runs as its own command. Only a `verify:` field or a fenced block in
// `## Verification` is read, and the allowlist still keeps an arbitrary line
// there from running. Command substitution and redirection (`` ` ``, `$(`, `>`, `<`) are
// rejected outright: they let an allowlisted first token smuggle an
// unrelated command in (e.g. `` bash -c "rm -rf $HOME" ``).
const COMMAND_ALLOWLIST = new Set([
  "pnpm",
  "npm",
  "npx",
  "yarn",
  "node",
  "tsc",
  "ocean",
  "make",
  "bash",
  "sh",
  "pytest",
  "jest",
  "vitest",
  "biome",
]);

type VerificationCheck = {
  command: string;
  exitCode: number;
  ok: boolean;
};

export type VerificationOutcome = {
  id: string;
  passed: boolean;
  reason: string;
  checks: VerificationCheck[];
  // Where the commands came from: the task's own declaration, or its project's `verify`.
  source: "task" | "project";
};

export type CommandRunner = (
  command: string,
  cwd: string,
) => Promise<{ exitCode: number }>;

const defaultRunner: CommandRunner = async (command, cwd) => {
  try {
    await execFile("bash", ["-lc", command], { cwd, timeout: 600_000 });
    return { exitCode: 0 };
  } catch (error) {
    const failure = error as { code?: number | string };
    const code =
      typeof failure.code === "number"
        ? failure.code
        : Number(failure.code) || 1;
    return { exitCode: code };
  }
};

/**
 * Pull runnable commands out of a task's verification declaration. A `verify:`
 * frontmatter field (string or comma-separated list) wins; otherwise each non-empty
 * line inside a fenced code block of the `## Verification` section. Inline-backtick
 * spans are prose, never commands: on T-308 a prose span naming `npm publish` was run
 * (T-317).
 */
function candidateCommands(source: string): string[] {
  const frontmatter = source
    .match(/^verify:\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^['"]|['"]$/g, "");
  if (frontmatter)
    return frontmatter
      .split(/\s*(?:,|&&|;)\s*/)
      .map((part) => part.trim())
      .filter(Boolean);

  const section = source
    .match(/\n## Verification\n\n([\s\S]*?)(?=\n## |$)/)?.[1]
    ?.trim();
  if (!section) return [];

  const fenced: string[] = [];
  for (const match of section.matchAll(/```[^\n]*\n([\s\S]*?)```/g))
    for (const line of match[1].split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) fenced.push(trimmed);
    }
  return fenced;
}

export function extractVerificationCommands(source: string): string[] {
  return candidateCommands(source).filter((command) =>
    isAllowedCommand(command),
  );
}

const UNSAFE_METACHARACTERS = /[`$><]/;
const SINGLE_AMPERSAND = /(?<!&)&(?!&)/;
const CHAIN_SEPARATOR = /\s*(?:&&|\|\||;|\|)\s*/;

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

// The project's first path when it is an absolute, existing directory; "" otherwise.
function projectDirectory(manifest: { paths: string[] }): string {
  const dir = manifest.paths[0] ? expandHome(manifest.paths[0]) : "";
  return dir && path.isAbsolute(dir) && isDirectory(dir) ? dir : "";
}

// Commands that carry their own program text: fine in a task someone wrote at the keyboard,
// not in project.json, which a session reads on its own.
const INLINE_PROGRAM_FLAG = /^(--eval|--print|-[a-zA-Z]*[ep][a-zA-Z]*)$/;

// A check proves the work; it never publishes, signs in or changes the machine. These
// package-manager verbs and a global install are refused from every source (T-317).
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);
const OUTWARD_VERBS = new Set([
  "publish",
  "unpublish",
  "deprecate",
  "login",
  "logout",
  "adduser",
  "owner",
  "token",
  "dist-tag",
]);

function isOutward(program: string, args: string[]): boolean {
  if (args.some((arg) => arg === "-g" || arg === "--global")) return true;
  return (
    PACKAGE_MANAGERS.has(program) && args.some((arg) => OUTWARD_VERBS.has(arg))
  );
}

function isAllowedCommand(
  command: string,
  origin: "task" | "project" = "task",
): boolean {
  if (UNSAFE_METACHARACTERS.test(command)) return false;
  if (SINGLE_AMPERSAND.test(command) || hasControlCharacters(command))
    return false;
  const links = command
    .split(CHAIN_SEPARATOR)
    .map((link) => link.trim())
    .filter(Boolean);
  if (links.length === 0) return false;
  return links.every((link) => {
    const [program, ...args] = link.split(/\s+/);
    if (!COMMAND_ALLOWLIST.has(program)) return false;
    if (isOutward(program, args)) return false;
    if (origin === "task") return true;
    if (program === "bash" || program === "sh") return false;
    return !(
      program === "node" && args.some((a) => INLINE_PROGRAM_FLAG.test(a))
    );
  });
}

/**
 * Independently verify a task by running the commands it declares. A task is
 * only verified when it declares at least one runnable check and every check
 * exits zero — the loop and `completeTask` never trust a self-reported
 * `state: done` on its own.
 */
export async function verifyTask(
  id: string,
  root = workspaceTasksRoot(),
  options: { cwd?: string; run?: CommandRunner } = {},
): Promise<VerificationOutcome> {
  const taskFile = resolveWithin(root, id, "task.md");
  const source = await readFile(taskFile, "utf8");
  const candidates = candidateCommands(source);
  const taskCommands = candidates.filter((command) =>
    isAllowedCommand(command),
  );
  const fail = (
    reason: string,
    from: VerificationOutcome["source"],
  ): VerificationOutcome => ({
    id,
    passed: false,
    reason,
    checks: [],
    source: from,
  });
  const noCommands = () =>
    fail(
      "no runnable verification commands declared; cannot self-certify done",
      "task",
    );
  // Commands were declared but none may run: that is a failure, never a reason to fall back.
  if (candidates.length > 0 && taskCommands.length === 0)
    return fail(
      `declared verification commands are not allowed: ${candidates.join(", ")}`,
      "task",
    );
  let commands = taskCommands;
  let cwd = options.cwd ?? repoRoot();
  let from: VerificationOutcome["source"] = "task";
  const project = projectOfTasksRoot(root);
  // Another project's task checks its own repo: `pnpm lint` in the engine would prove nothing.
  if (
    candidates.length > 0 &&
    options.cwd === undefined &&
    project &&
    !isWorkspaceProject(project)
  ) {
    let manifest: Awaited<ReturnType<typeof readProjectManifest>> = null;
    try {
      manifest = await readProjectManifest(project);
    } catch {
      // Unreadable manifest: reported below as a missing path.
    }
    const dir = manifest ? projectDirectory(manifest) : "";
    if (!dir)
      return fail(
        `task verify for ${project} needs the project's first path to be an absolute, existing directory`,
        "task",
      );
    cwd = dir;
  }
  if (candidates.length === 0) {
    let manifest: Awaited<ReturnType<typeof readProjectManifest>> = null;
    let verify: string[] = [];
    try {
      manifest = project ? await readProjectManifest(project) : null;
      verify = manifest ? projectVerify(manifest) : [];
    } catch (error) {
      return fail(
        `project verify is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        "project",
      );
    }
    if (!manifest || !verify.length) return noCommands();
    from = "project";
    const rejected = verify.find(
      (command) => !isAllowedCommand(command, "project"),
    );
    if (rejected)
      return fail(`project verify command is not allowed: ${rejected}`, from);
    // The caller's cwd (a worktree, say) wins; otherwise the project's first path.
    if (options.cwd === undefined) {
      const dir = projectDirectory(manifest);
      if (!dir)
        return fail(
          `project verify needs the project's first path to be an absolute, existing directory: ${manifest.paths[0] ? expandHome(manifest.paths[0]) : "(none)"}`,
          from,
        );
      cwd = dir;
    }
    commands = verify;
  }
  const run = options.run ?? defaultRunner;
  const checks: VerificationCheck[] = [];
  for (const command of commands) {
    const { exitCode } = await run(command, cwd);
    checks.push({ command, exitCode, ok: exitCode === 0 });
  }
  const passed = checks.every((check) => check.ok);
  return {
    id,
    passed,
    reason: passed
      ? "all verification checks passed"
      : `verification failed: ${checks
          .filter((check) => !check.ok)
          .map((check) => check.command)
          .join(", ")}`,
    checks,
    source: from,
  };
}

// What a task declares, and which of it the allowlist refuses: a dry readiness check that runs
// nothing (T-291).
export function declaredVerificationCommands(source: string): {
  declared: string[];
  refused: string[];
} {
  const declared = candidateCommands(source);
  return {
    declared,
    refused: declared.filter((command) => !isAllowedCommand(command)),
  };
}
