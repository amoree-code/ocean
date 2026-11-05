#!/usr/bin/env node
import { spawnSync } from "node:child_process";

// The git root is the parent of kernel/ (T-310), and lefthook installs from there. Outside a
// git checkout (a packed install) there is nothing to hook.
const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
});
if (top.status === 0) {
  const result = spawnSync("lefthook", ["install"], {
    cwd: top.stdout.trim(),
    stdio: "inherit",
    shell: true,
  });
  process.exit(result.status ?? 0);
}
