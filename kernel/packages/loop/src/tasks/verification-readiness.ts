import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  isWorkspaceProject,
  projectOfTasksRoot,
  repoRoot,
  resolveWithin,
  workspaceTasksRoot,
} from "@ocean/core/shared/paths.js";
import {
  expandHome,
  projectVerify,
  readProjectManifest,
} from "@ocean/core/shared/project-resolution.js";
import { declaredVerificationCommands } from "./verify-task.js";

// Whether `ocean tasks complete` will be able to verify this task, checked early and without
// running anything (T-291): T-283 named a test file that did not exist, which surfaced only at
// completion. Advisory: a checkpoint reports it and never refuses.
export async function verificationReadiness(
  id: string,
  root = workspaceTasksRoot(),
): Promise<{ ready: boolean; warnings: string[] }> {
  const source = await readFile(resolveWithin(root, id, "task.md"), "utf8");
  const { declared, refused } = declaredVerificationCommands(source);
  const warnings = refused.map(
    (command) => `declared verification is not allowed to run: ${command}`,
  );
  const project = projectOfTasksRoot(root);
  const manifest = project
    ? await readProjectManifest(project).catch(() => null)
    : null;
  const runnable = declared.filter((command) => !refused.includes(command));
  if (!declared.length && !(manifest && projectVerify(manifest).length))
    warnings.push(
      "no verification command declared and no project verify: tasks complete will refuse",
    );
  // Task commands run in the engine for the workspace project, else in the project's first path.
  const cwd =
    project && !isWorkspaceProject(project) && manifest?.paths?.[0]
      ? expandHome(manifest.paths[0])
      : repoRoot();
  for (const command of runnable)
    for (const file of missingTestFiles(command, cwd))
      warnings.push(`test file not found: ${file} (in ${command})`);
  return { ready: warnings.length === 0, warnings };
}

// Test files named after `node --test` that do not exist where the command will run. A
// `pnpm --filter <name> exec` prefix runs inside that workspace package.
function missingTestFiles(command: string, cwd: string): string[] {
  const missing: string[] = [];
  for (const link of command.split(/\s*(?:&&|;)\s*/)) {
    const tokens = link.trim().split(/\s+/);
    const test = tokens.indexOf("--test");
    if (test < 0 || !tokens.slice(0, test).includes("node")) continue;
    // `--filter <name>` or `--filter=<name>`.
    const filter = tokens.findIndex(
      (token) => token === "--filter" || token.startsWith("--filter="),
    );
    const name =
      filter < 0
        ? undefined
        : tokens[filter].includes("=")
          ? tokens[filter].slice("--filter=".length)
          : tokens[filter + 1];
    const base =
      tokens[0] === "pnpm" && filter >= 0 ? packageDirectory(cwd, name) : cwd;
    if (!base) continue;
    for (const arg of tokens.slice(test + 1))
      if (!arg.startsWith("-") && /\.(?:[cm]?js|ts)$/.test(arg))
        if (!existsSync(path.resolve(base, arg))) missing.push(arg);
  }
  return missing;
}

function packageDirectory(
  cwd: string,
  name: string | undefined,
): string | null {
  if (!name) return null;
  const packages = path.join(cwd, "packages");
  let entries: string[];
  try {
    entries = readdirSync(packages);
  } catch {
    return null;
  }
  for (const entry of entries)
    try {
      const manifest = JSON.parse(
        readFileSync(path.join(packages, entry, "package.json"), "utf8"),
      );
      if (manifest.name === name) return path.join(packages, entry);
    } catch {
      // not a package
    }
  return null;
}
