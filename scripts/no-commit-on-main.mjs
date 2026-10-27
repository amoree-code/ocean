#!/usr/bin/env node
// Pre-commit guard (T-287): work lands through a branch and a pull request, never as a commit
// on `main` — a session that commits there leaves `main` ahead of origin with unreviewed work.
// A detached HEAD or any other branch passes; `git commit --no-verify` is the deliberate escape.
import { spawnSync } from "node:child_process";

const head = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
  encoding: "utf8",
});
const branch = head.status === 0 ? head.stdout.trim() : "";
if (branch === "main") {
  console.error(
    "Refusing to commit on main: branch first (git switch -c <type>/t<nnn>-<slug>), land it through a PR.",
  );
  process.exit(1);
}
