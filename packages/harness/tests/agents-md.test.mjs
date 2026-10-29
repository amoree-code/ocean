import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { repoRoot } from "@ocean/core/shared/paths.js";

const agents = () => readFileSync(path.join(repoRoot(), "AGENTS.md"), "utf8");

// Every repo file AGENTS.md sends a session to must exist, or each session pays for a dead
// instruction. `graft/` is a per-machine, git-ignored build, so its paths are exempt.
test("every file path AGENTS.md names exists in the repo", () => {
  const paths = [
    ...agents().matchAll(/`([\w.-]+(?:\/[\w.-]+)+\.(?:md|ts|mjs|json))`/g),
  ]
    .map((match) => match[1])
    .filter((file) => !file.startsWith("graft/"));
  assert.ok(paths.length > 0);
  const missing = paths.filter(
    (file) => !existsSync(path.join(repoRoot(), file)),
  );
  assert.deepEqual(missing, []);
});

test("AGENTS.md makes graft conditional on it being installed", () => {
  const text = agents();
  assert.doesNotMatch(text, /--source` first, always/);
  assert.match(text, /When `graft` is installed/);
});
