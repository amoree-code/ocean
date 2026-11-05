#!/usr/bin/env node
// Decides and prepares the next release (T-312). Runs on every push to main from
// .github/workflows/release.yml; nobody runs it by hand.
//
//   node scripts/auto-release.mjs [--write] [--notes <file>] [--tagged <version>...]
//
// What is pending: the root CHANGELOG.md's Unreleased lines and the changesets in .changeset/.
// The bump: major on a `major` changeset or a `type!:` line (`feat!: …`), minor on a `minor` changeset
// or a `feat` line, otherwise patch; nothing pending, no release. A version already set by hand
// and not yet tagged (`--tagged` lists the tags that exist) is released as it is.
//
// --write sets the version in every packages/*/package.json, regenerates the marketplace index
// (its skill versions follow the package), moves the Unreleased lines under `## <version>` in
// CHANGELOG.md, adds the same section to packages/harness/CHANGELOG.md, and deletes the
// consumed changesets. Prints {version, previous, bump} as JSON; `version` is null when there is
// nothing to release. --notes writes the release notes to a file.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LEVELS = ["patch", "minor", "major"];

// The `- ` lines under `## Unreleased`, up to the next heading.
export function unreleasedLines(changelog) {
  const start = changelog.indexOf("\n## Unreleased");
  if (start < 0) return [];
  const body = changelog.slice(changelog.indexOf("\n", start + 1) + 1);
  const end = body.search(/^## /m);
  return (end < 0 ? body : body.slice(0, end))
    .split("\n")
    .filter((line) => line.startsWith("- "));
}

// A changeset's bump (the highest in its frontmatter) and its summary.
export function parseChangeset(text) {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return null;
  const levels = [
    ...match[1].matchAll(/:\s*["']?(patch|minor|major)["']?/g),
  ].map((found) => found[1]);
  if (!levels.length) return null;
  return {
    bump: levels.reduce((a, b) =>
      LEVELS.indexOf(b) > LEVELS.indexOf(a) ? b : a,
    ),
    summary: match[2].trim(),
  };
}

export function bumpOf(lines, changesets) {
  const levels = changesets.map((changeset) => changeset.bump);
  for (const line of lines) {
    if (/^- \w+(\([^)]*\))?!:/.test(line)) levels.push("major");
    else if (/^- feat\b/.test(line)) levels.push("minor");
    else levels.push("patch");
  }
  if (!levels.length) return null;
  return levels.reduce((a, b) =>
    LEVELS.indexOf(b) > LEVELS.indexOf(a) ? b : a,
  );
}

export function nextVersion(version, bump) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// Unreleased stays as an empty heading; its lines move under the new version.
export function releaseChangelog(changelog, version, date) {
  const lines = unreleasedLines(changelog);
  const start = changelog.indexOf("\n## Unreleased");
  const bodyStart = changelog.indexOf("\n", start + 1) + 1;
  const rest = changelog.slice(bodyStart);
  const end = rest.search(/^## /m);
  const tail = end < 0 ? "" : rest.slice(end);
  return `${changelog.slice(0, bodyStart)}\n## ${version} (${date})\n\n${lines.join("\n")}\n\n${tail}`;
}

export function packageChangelog(changelog, version, notes) {
  const heading = changelog.indexOf("\n## ");
  const section = `## ${version}\n\n${notes}\n`;
  return heading < 0
    ? `${changelog.trimEnd()}\n\n${section}`
    : `${changelog.slice(0, heading + 1)}${section}\n${changelog.slice(heading + 1)}`;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const notesIndex = args.indexOf("--notes");
  const tagged = new Set();
  args.forEach((arg, index) => {
    if (args[index - 1] === "--tagged") tagged.add(arg.replace(/^v/, ""));
  });

  const changelogFile = path.join(root, "CHANGELOG.md");
  const changelog = readFileSync(changelogFile, "utf8");
  const changesetDir = path.join(root, ".changeset");
  const changesetFiles = readdirSync(changesetDir).filter(
    (name) => name.endsWith(".md") && name !== "README.md",
  );
  const changesets = changesetFiles
    .map((name) =>
      parseChangeset(readFileSync(path.join(changesetDir, name), "utf8")),
    )
    .filter(Boolean);
  const lines = unreleasedLines(changelog);

  const harnessFile = path.join(root, "packages", "harness", "package.json");
  const previous = JSON.parse(readFileSync(harnessFile, "utf8")).version;
  const bump = bumpOf(lines, changesets);
  const version = !tagged.has(previous)
    ? previous
    : bump
      ? nextVersion(previous, bump)
      : null;
  const notes = [
    ...lines,
    ...changesets.map(
      (changeset) => `- ${changeset.summary.replace(/\n+/g, " ")}`,
    ),
  ].join("\n");

  if (version && write) {
    for (const entry of readdirSync(path.join(root, "packages"))) {
      const file = path.join(root, "packages", entry, "package.json");
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      manifest.version = version;
      writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    execFileSync(process.execPath, [
      path.join(
        root,
        "packages",
        "harness",
        "scripts",
        "generate-marketplace-index.mjs",
      ),
    ]);
    const date = new Date().toISOString().slice(0, 10);
    if (lines.length)
      writeFileSync(changelogFile, releaseChangelog(changelog, version, date));
    const harnessChangelog = path.join(
      root,
      "packages",
      "harness",
      "CHANGELOG.md",
    );
    const current = readFileSync(harnessChangelog, "utf8");
    if (!current.includes(`\n## ${version}\n`))
      writeFileSync(
        harnessChangelog,
        packageChangelog(current, version, notes || "Maintenance release."),
      );
    for (const name of changesetFiles) rmSync(path.join(changesetDir, name));
  }
  if (notesIndex >= 0)
    writeFileSync(args[notesIndex + 1], `${notes || "Maintenance release."}\n`);
  console.log(JSON.stringify({ version, previous, bump }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
