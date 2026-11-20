import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

// The commit checked out at `cwd`, or null outside a repository (T-320 F1).
export async function headCommit(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// Whether anything under `paths` differs from `base`: committed since, staged, unstaged or
// untracked. null when git cannot answer (no repository, unknown commit).
export async function changedSince(
  cwd: string,
  base: string,
  paths: string[],
): Promise<boolean | null> {
  try {
    const { stdout: diff } = await execFile(
      "git",
      ["diff", "--name-only", base, "--", ...paths],
      { cwd, maxBuffer: 16 * 1024 * 1024 },
    );
    if (diff.trim()) return true;
    const { stdout: untracked } = await execFile(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--", ...paths],
      { cwd, maxBuffer: 16 * 1024 * 1024 },
    );
    return Boolean(untracked.trim());
  } catch {
    return null;
  }
}
