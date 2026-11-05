// PR gate: a pull request must add a line to the root CHANGELOG.md, or carry the
// `skip-changelog` label. Runs only on pull_request events; any other run passes.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const event = process.env.GITHUB_EVENT_PATH
  ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
  : null;
const pr = event?.pull_request;
if (!pr) {
  console.log("check:changelog: not a pull request, skipped");
  process.exit(0);
}
if ((pr.labels ?? []).some((label) => label.name === "skip-changelog")) {
  console.log("check:changelog: skip-changelog label set, skipped");
  process.exit(0);
}
const base = process.env.CHANGELOG_BASE ?? `origin/${pr.base.ref}`;
const diff = execFileSync(
  "git",
  ["diff", "--unified=0", `${base}...HEAD`, "--", "CHANGELOG.md"],
  { encoding: "utf8" },
);
const added = diff
  .split("\n")
  .filter((l) => l.startsWith("+") && !l.startsWith("+++") && l.trim() !== "+");
if (added.length === 0) {
  console.error(
    "check:changelog: add a line under 'Unreleased' in CHANGELOG.md, or label the PR skip-changelog.",
  );
  process.exit(1);
}
console.log(`check:changelog: ${added.length} changelog line(s) added`);
