import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oceanPackageRoot = path.join(root, "packages", "harness");
const packageJson = JSON.parse(
  await readFile(path.join(oceanPackageRoot, "package.json"), "utf8"),
);
const version = packageJson.version;
const changelog = await readFile(
  path.join(oceanPackageRoot, "CHANGELOG.md"),
  "utf8",
);
const readme = await readFile(path.join(root, "README.md"), "utf8");
const findings = [];

if (typeof version !== "string" || !version.trim())
  findings.push("package.json is missing a valid version");
if (!changelog.includes(`## ${version}`))
  findings.push(`CHANGELOG.md is missing ## ${version}`);
if (!readme.includes("CHANGELOG.md"))
  findings.push("README.md does not link CHANGELOG.md");
if (
  JSON.stringify(packageJson.files) !==
  JSON.stringify(["dist", "templates", "skills"])
)
  findings.push("package files allowlist changed");

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.relative(
      oceanPackageRoot,
      path.join(directory, entry.name),
    );
    if (entry.isDirectory()) await walk(path.join(directory, entry.name));
    if (
      /(?:^|[/\\])runtime(?:[/\\]|$)|(?:^|[/\\])node_modules(?:[/\\]|$)|\/Users\/|\/home\//.test(
        relative,
      )
    ) {
      findings.push(`disallowed package path: ${relative}`);
    }
  }
}

for (const directory of ["dist", "templates", "skills"])
  await walk(path.join(oceanPackageRoot, directory));
if (findings.length) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Package boundary valid for Ocean ${version}`);
}
