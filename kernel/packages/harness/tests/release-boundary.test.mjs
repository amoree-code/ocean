import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { boundaryFindings } from "../../../scripts/release-boundary.mjs";

// T-308: what may ship in the npm tarball. A staged package is a temp dir shaped like the real
// one; the template inside it keeps one approved empty placeholder.
const purity = path.resolve("../../scripts/check-template-purity.mjs");

async function stagedPackage() {
  const stage = await mkdtemp(path.join(os.tmpdir(), "ocean-release-stage-"));
  const put = async (file, text = "") => {
    await mkdir(path.dirname(path.join(stage, file)), { recursive: true });
    await writeFile(path.join(stage, file), text);
  };
  await put("package.json", '{"name":"fixture","version":"0.0.0"}\n');
  await put("dist/main.js", "console.log('ocean');\n");
  await put("node_modules/@ocean/core/dist/index.js", "export {};\n");
  await put(
    "templates/workspace/MANIFEST.json",
    `${JSON.stringify({ files: { "01-daily/.gitkeep": "keep" } })}\n`,
  );
  await put("templates/workspace/01-daily/.gitkeep");
  return { stage, put };
}

async function files(stage, directory = stage) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await files(stage, target)));
    else found.push(path.relative(stage, target).split(path.sep).join("/"));
  }
  return found;
}

const findingsFor = async (stage) =>
  boundaryFindings(stage, await files(stage));

test("an approved empty .gitkeep in the template ships", async () => {
  const { stage } = await stagedPackage();
  assert.deepEqual(await findingsFor(stage), []);
});

test("a private file beside the approved .gitkeep is refused by the package and the template check", async () => {
  const { stage, put } = await stagedPackage();
  await put(
    "templates/workspace/01-daily/2026-11-04.md",
    "# 4 November\n\nCalled the embassy about the visa appointment.\n",
  );
  assert.deepEqual(await findingsFor(stage), [
    "template 01-daily/2026-11-04.md: not-in-manifest",
  ]);
  const run = spawnSync(
    process.execPath,
    [purity, "--root", path.join(stage, "templates", "workspace")],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 1);
  assert.deepEqual(
    JSON.parse(run.stderr).findings.map((f) => `${f.file}:${f.rule}`),
    ["01-daily/2026-11-04.md:not-in-manifest"],
  );
});

test("a private record carrying a home path or address is refused by the privacy scan", async () => {
  const { stage, put } = await stagedPackage();
  // Assembled at run time so this file does not trip the repo's own privacy scan.
  await put(
    "templates/workspace/01-daily/notes.md",
    `see ${["", "Users", "someone", "notes"].join("/")}\n`,
  );
  await put(
    "node_modules/@ocean/core/dist/contact.js",
    `export const to = "${["someone", "example.test"].join("@")}";\n`,
  );
  const findings = await findingsFor(stage);
  for (const expected of [
    "privacy templates/workspace/01-daily/notes.md: private-path",
    "privacy node_modules/@ocean/core/dist/contact.js: personal-data",
  ])
    assert.ok(findings.includes(expected), `${expected} in ${findings}`);
});

test("workspace data, machine state, credentials and build files never ship", async () => {
  const { stage, put } = await stagedPackage();
  for (const file of [
    "01-daily/2026-11-04.md",
    "02-personal/MEMORY.md",
    "04-projects/acme/tasks/T-1/task.md",
    "bridge/config/memory.json",
    "sessions/sessions.sqlite",
    "charter/core.md",
    ".index/brain.sqlite",
    "templates/.env.local",
    "skills/.claude/settings.json",
    "dist/id_ed25519",
    "src/main.ts",
    "dist/main.js.map",
    "dist/tests/x.js",
    "node_modules/@ocean/core/src/index.ts",
  ])
    await put(file, "x\n");
  const refused = (await findingsFor(stage)).filter((finding) =>
    finding.startsWith("must not ship "),
  );
  assert.equal(refused.length, 14, refused.join("\n"));
});
