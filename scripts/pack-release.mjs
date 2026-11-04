#!/usr/bin/env node
// Packs the CLI as one installable npm tarball. The internal @ocean/* packages are workspace
// dependencies that are not on npm, so they ship inside it as bundleDependencies: each one's
// built JavaScript is copied into the staged package's node_modules, and their third-party
// dependencies move up to the CLI's own, where npm installs them. Run `pnpm build` first.
//
//   node scripts/pack-release.mjs [--out <dir>]
//
// Prints the tarball path. Nothing is published.
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boundaryFindings } from "./release-boundary.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outIndex = process.argv.indexOf("--out");
const out = path.resolve(
  outIndex >= 0
    ? process.argv[outIndex + 1]
    : await mkdtemp(path.join(os.tmpdir(), "ocean-release-")),
);
const stage = path.join(out, "package");
await mkdir(stage, { recursive: true });
if ((await readdir(stage)).length) throw new Error(`${stage} is not empty`);

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const workspace = new Map();
for (const entry of await readdir(path.join(root, "packages"))) {
  const dir = path.join(root, "packages", entry);
  workspace.set((await readJson(path.join(dir, "package.json"))).name, dir);
}
const isWorkspaceSpec = (spec) => spec.startsWith("workspace:");

const cli = await readJson(
  path.join(root, "packages", "harness", "package.json"),
);

// Every internal package the CLI reaches, transitively.
const internal = new Map();
const pending = Object.keys(cli.dependencies).filter((name) =>
  isWorkspaceSpec(cli.dependencies[name]),
);
while (pending.length) {
  const name = pending.pop();
  if (internal.has(name)) continue;
  const dir = workspace.get(name);
  if (!dir) throw new Error(`${name} is not a workspace package`);
  const manifest = await readJson(path.join(dir, "package.json"));
  internal.set(name, { dir, manifest });
  for (const [dep, spec] of Object.entries(manifest.dependencies ?? {}))
    if (isWorkspaceSpec(spec)) pending.push(dep);
}

// The CLI's dependencies: its own third-party ones, the internal packages' third-party ones,
// and each internal package at its exact version (bundled, so npm never fetches it).
const dependencies = {};
const addDependency = (name, spec, from) => {
  if (dependencies[name] && dependencies[name] !== spec)
    throw new Error(
      `${name}: ${from} needs ${spec}, already ${dependencies[name]}`,
    );
  dependencies[name] = spec;
};
for (const [name, spec] of Object.entries(cli.dependencies))
  if (!isWorkspaceSpec(spec)) addDependency(name, spec, cli.name);
for (const [name, { manifest }] of internal) {
  addDependency(name, manifest.version, cli.name);
  for (const [dep, spec] of Object.entries(manifest.dependencies ?? {}))
    if (!isWorkspaceSpec(spec)) addDependency(dep, spec, name);
}

// Only the JavaScript ships: the .d.ts and .map files describe src/, which does not.
const javascriptOnly = (source) => !/\.(?:d\.ts|map)$/.test(source);

const { scripts, devDependencies, ...published } = cli;
await writeFile(
  path.join(stage, "package.json"),
  `${JSON.stringify(
    {
      ...published,
      dependencies: Object.fromEntries(
        Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)),
      ),
      bundleDependencies: [...internal.keys()].sort(),
    },
    null,
    2,
  )}\n`,
);
const cliDir = path.join(root, "packages", "harness");
for (const entry of cli.files)
  await cp(path.join(cliDir, entry), path.join(stage, entry), {
    recursive: true,
    filter: javascriptOnly,
  });
await cp(path.join(cliDir, "CHANGELOG.md"), path.join(stage, "CHANGELOG.md"));
for (const file of ["README.md", "LICENSE"])
  await cp(path.join(root, file), path.join(stage, file));

for (const [name, { dir, manifest }] of internal) {
  const target = path.join(stage, "node_modules", name);
  await cp(path.join(dir, "dist"), path.join(target, "dist"), {
    recursive: true,
    filter: javascriptOnly,
  });
  // Resolved at runtime through the CLI's node_modules, so a bundled package lists none.
  const exports = JSON.parse(
    JSON.stringify(manifest.exports, (key, value) =>
      key === "source" || key === "types" ? undefined : value,
    ),
  );
  await writeFile(
    path.join(target, "package.json"),
    `${JSON.stringify(
      {
        name,
        version: manifest.version,
        license: cli.license,
        type: manifest.type,
        exports,
      },
      null,
      2,
    )}\n`,
  );
}

// npm 11 prints an array; npm 12 an object keyed by package name.
const npmPack = (...flags) => {
  const report = JSON.parse(
    execFileSync("npm", ["pack", "--json", ...flags], {
      cwd: stage,
      encoding: "utf8",
    }),
  );
  return Array.isArray(report) ? report[0] : Object.values(report)[0];
};

// Judged before the tarball exists, on npm's own list of what it would pack: the entry point,
// the runtime assets and every bundled package must be there, and release-boundary.mjs must
// find nothing that may not leave the machine.
const shipped = npmPack("--dry-run").files.map((file) => file.path);
const findings = [
  "dist/main.js",
  "templates/",
  "skills/",
  "market/",
  "ocean-marketplace.json",
  ...[...internal.keys()].map((name) => `node_modules/${name}/dist/`),
]
  .filter((required) => !shipped.some((file) => file.startsWith(required)))
  .map((required) => `missing ${required}`)
  .concat(await boundaryFindings(stage, shipped));
if (findings.length) {
  console.error(findings.join("\n"));
  process.exit(1);
}
const packed = npmPack("--pack-destination", out);
console.log(
  JSON.stringify(
    {
      tarball: path.join(out, packed.filename),
      files: packed.entryCount,
      size: packed.size,
      unpackedSize: packed.unpackedSize,
      bundled: [...internal.keys()].sort(),
    },
    null,
    2,
  ),
);
