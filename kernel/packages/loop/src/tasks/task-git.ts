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

// A local branch of the repo at `cwd` whose name carries one of `matches`'s tokens and that has
// commits its base does not (T-327): the signal that work on a task has started. The base is the
// remote's default branch (`origin/HEAD`), else `main`, else `master`. Returns "branch X is N
// commits ahead of <base>", or null when there is none or git cannot answer.
export async function branchAheadOfBase(
  cwd: string,
  matches: (branch: string) => boolean,
): Promise<string | null> {
  const git = async (...args: string[]) =>
    (await execFile("git", args, { cwd })).stdout.trim();
  try {
    let base = "";
    for (const candidate of [
      await git("symbolic-ref", "--short", "refs/remotes/origin/HEAD").catch(
        () => "",
      ),
      "main",
      "master",
    ]) {
      if (
        candidate &&
        (await git("rev-parse", "--verify", candidate).catch(() => ""))
      ) {
        base = candidate;
        break;
      }
    }
    if (!base) return null;
    const branches = (
      await git("for-each-ref", "--format=%(refname:short)", "refs/heads")
    )
      .split("\n")
      .filter((branch) => branch && branch !== base && matches(branch));
    for (const branch of branches) {
      const ahead = Number(
        await git("rev-list", "--count", `${base}..${branch}`),
      );
      if (ahead > 0)
        return `branch ${branch} is ${ahead} commit${ahead === 1 ? "" : "s"} ahead of ${base}`;
    }
    return null;
  } catch {
    return null;
  }
}
