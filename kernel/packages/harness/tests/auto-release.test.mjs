import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import {
  bumpOf,
  nextVersion,
  packageChangelog,
  parseChangeset,
  releaseChangelog,
  unreleasedLines,
} from "../../../scripts/auto-release.mjs";

const CHANGELOG = `# Changelog

Every pull request adds a line under **Unreleased**.

## Unreleased

- fix(T-1): a bug (#1)
- feat(T-2): a feature (#2)

## 2026-10-15

- docs: older (#0)
`;

test("the pending lines are the ones under Unreleased only", () => {
  assert.deepEqual(unreleasedLines(CHANGELOG), [
    "- fix(T-1): a bug (#1)",
    "- feat(T-2): a feature (#2)",
  ]);
  assert.deepEqual(
    unreleasedLines("# Changelog\n\n## Unreleased\n\n## 1.0.0\n- x\n"),
    [],
  );
  assert.deepEqual(unreleasedLines("# Changelog\n"), []);
});

test("a changeset gives its highest bump and its summary", () => {
  assert.deepEqual(
    parseChangeset('---\n"ocean": minor\n---\n\nAdds a thing.\n'),
    {
      bump: "minor",
      summary: "Adds a thing.",
    },
  );
  assert.deepEqual(
    parseChangeset("---\n'a': patch\n'b': major\n---\nBig.").bump,
    "major",
  );
  assert.equal(parseChangeset("no frontmatter"), null);
  assert.equal(parseChangeset("---\n---\nempty"), null);
});

test("the bump is the highest of what is pending, and nothing pending is no release", () => {
  assert.equal(bumpOf(["- docs: x", "- fix: y"], []), "patch");
  assert.equal(bumpOf(["- fix: y", "- feat(T-2): z"], []), "minor");
  assert.equal(bumpOf(["- feat!: drops Node 20"], []), "major");
  // Only the `!` marks a breaking change; the word in prose does not.
  assert.equal(bumpOf(["- feat: BREAKING: says so in prose"], []), "minor");
  assert.equal(bumpOf([], [{ bump: "minor", summary: "" }]), "minor");
  assert.equal(bumpOf([], []), null);
});

test("next versions follow semver", () => {
  assert.equal(nextVersion("1.0.0", "patch"), "1.0.1");
  assert.equal(nextVersion("1.0.9", "minor"), "1.1.0");
  assert.equal(nextVersion("1.4.2", "major"), "2.0.0");
});

test("a release moves the Unreleased lines under the version and keeps the rest", () => {
  const next = releaseChangelog(CHANGELOG, "1.1.0", "2026-11-05");
  assert.equal(unreleasedLines(next).length, 0);
  assert.match(
    next,
    /## Unreleased\n\n## 1\.1\.0 \(2026-11-05\)\n\n- fix\(T-1\): a bug \(#1\)\n- feat\(T-2\): a feature \(#2\)\n\n## 2026-10-15\n\n- docs: older \(#0\)\n$/,
  );
  assert.ok(next.startsWith("# Changelog\n\nEvery pull request"));
});

test("the package changelog gets the newest section first", () => {
  const before = "# Changelog\n\n## 1.0.0\n\nFirst.\n";
  assert.equal(
    packageChangelog(before, "1.0.1", "- fix: y"),
    "# Changelog\n\n## 1.0.1\n\n- fix: y\n\n## 1.0.0\n\nFirst.\n",
  );
  assert.equal(
    packageChangelog("# Changelog\n", "1.0.1", "- fix: y"),
    "# Changelog\n\n## 1.0.1\n\n- fix: y\n",
  );
});

test("a dry run reports the next version and writes nothing", () => {
  const script = path.resolve("../../scripts/auto-release.mjs");
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  const untagged = JSON.parse(run().stdout);
  // The current version has no tag in this run, so it is released as it is.
  assert.equal(untagged.version, untagged.previous);
  const tagged = JSON.parse(run("--tagged", `v${untagged.previous}`).stdout);
  assert.equal(tagged.previous, untagged.previous);
  if (tagged.bump)
    assert.equal(tagged.version, nextVersion(tagged.previous, tagged.bump));
  else assert.equal(tagged.version, null);
});
