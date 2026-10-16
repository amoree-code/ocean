#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const findings = [];
const ignoredDirectories = new Set([".git", "node_modules", "dist"]);
const ignoredFiles = new Set(["LICENSE", "pnpm-lock.yaml"]);
const gitRepository = (() => {
  try {
    execFileSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
})();
const secretPatterns = [
  /(?:^|[^A-Za-z0-9_-])(?:sk-(?:ant-)?|AIza|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8,}/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}["']?/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
];
const privatePathPattern =
  /(?:^|[\s'"`])(?:\/Users\/[^\s'"`]+|\/home\/[^\s'"`]+|[A-Za-z]:\\Users\\[^\s'"`]+)/;
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

// One `git ls-files` call lists every tracked file plus every untracked file that is not
// ignored — the same set the old per-file `git check-ignore` walk produced, without spawning a
// process per file (that took 14-17 s on a busy machine and tripped `ocean doctor`'s 20 s limit).
function gitFiles() {
  const out = execFileSync(
    "git",
    [
      "-C",
      root,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  return out.toString("utf8").split("\0").filter(Boolean);
}
const skipped = (relative) => {
  const parts = relative.split(/[\\/]/);
  return (
    parts.slice(0, -1).some((part) => ignoredDirectories.has(part)) ||
    ignoredFiles.has(parts.at(-1))
  );
};
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    // In a linked git worktree `.git` is a file ("gitdir: /abs/path"), not a directory.
    if (directory === root && entry.name === ".git") continue;
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target);
    else if (!ignoredFiles.has(entry.name)) await scan(target);
  }
}
async function scan(file) {
  // A tracked file deleted from the working tree is still listed by git; nothing to scan.
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size > 1_000_000) return;
  const content = await readFile(file, "utf8").catch(() => null);
  if (content === null || content.includes("\u0000")) return;
  const relative = path.relative(root, file);
  if (secretPatterns.some((pattern) => pattern.test(content)))
    findings.push({ type: "credential", path: relative });
  if (privatePathPattern.test(content))
    findings.push({ type: "private-path", path: relative });
  if (emailPattern.test(content) && !relative.endsWith(".md"))
    findings.push({ type: "personal-data", path: relative });
}
if (gitRepository) {
  for (const relative of gitFiles())
    if (!skipped(relative)) await scan(path.join(root, relative));
} else await walk(root);
if (findings.length) {
  console.error(JSON.stringify({ ok: false, findings }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, scannedRoot: root }));
