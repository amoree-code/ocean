import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { seedWorkspaceTemplate } from "../dist/application/layout/workspace-template.js";

// T-296 P3c: the shipped workspace template and its purity check.
const script = path.resolve("../../scripts/check-template-purity.mjs");
const TEMPLATE = path.resolve("templates/workspace");

function check(args) {
  const run = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
  });
  return {
    code: run.status,
    stderr: run.stderr,
    findings: run.status
      ? JSON.parse(run.stderr).findings.map((f) => `${f.file}:${f.rule}`)
      : [],
  };
}

async function copyTemplate() {
  const root = path.join(
    await mkdtemp(path.join(os.tmpdir(), "ocean-template-")),
    "workspace",
  );
  await cp(TEMPLATE, root, { recursive: true });
  return root;
}

test("the shipped template passes its purity check", () => {
  const result = check([]);
  assert.equal(result.code, 0, result.stderr);
});

test("purity check rejects personal data, content in private files and manifest drift", async () => {
  const root = await copyTemplate();
  const append = async (file, text) =>
    writeFile(
      path.join(root, file),
      `${await readFile(path.join(root, file), "utf8")}${text}`,
    );
  // Assembled at run time so this file does not trip the privacy scan.
  await append(
    "charter/core.md",
    `\nmail ${["someone", "example.test"].join("@")}\n`,
  );
  await append(
    "charter/policies/git.md",
    `\nsee ${["", "Users", "someone", "x"].join("/")}\n`,
  );
  await append("charter/policies/task.md", `\ncall +1 555 123 4567\n`);
  await append("06-templates/task.md", `\nkey ${"ghp_"}${"k".repeat(36)}\n`);
  await append(
    "02-personal/CONFLICTS.md",
    "\nThe owner lives somewhere specific.\n",
  );
  await writeFile(path.join(root, "01-daily/.gitkeep"), "x");
  await writeFile(path.join(root, "stray.md"), "# stray\n");
  const { rm } = await import("node:fs/promises");
  await rm(path.join(root, "06-templates/session.md"));
  const findings = check(["--root", root]).findings;
  for (const expected of [
    "charter/core.md:email",
    "charter/policies/git.md:home-path",
    "charter/policies/task.md:phone",
    "06-templates/task.md:credential",
    "02-personal/CONFLICTS.md:private-file-has-content",
    "01-daily/.gitkeep:keep-not-empty",
    "stray.md:not-in-manifest",
    "06-templates/session.md:missing-file",
  ])
    assert.ok(findings.includes(expected), `${expected} in ${findings}`);
});

test("owner mode rejects private terms and shared 12-word runs without printing them", async () => {
  const root = await copyTemplate();
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ocean-private-"));
  const secretPlace = "Zorvathia";
  const privateSentence =
    "the owner moved to the northern harbour town after the winter contract ended early";
  const quotedPolicy =
    "a run of twelve words that the private notes quote from a generic policy file";
  await mkdir(path.join(workspace, "charter/policies"), { recursive: true });
  await writeFile(
    path.join(workspace, "charter/policies/privacy-terms.txt"),
    `# terms\n${secretPlace}\n`,
  );
  await writeFile(
    path.join(workspace, "charter/policies/generic.md"),
    `${quotedPolicy}\n`,
  );
  await mkdir(path.join(workspace, "02-personal"), { recursive: true });
  await writeFile(
    path.join(workspace, "02-personal/travel.md"),
    `${privateSentence}\nfiller words only the private note has\n${quotedPolicy}\n`,
  );
  await writeFile(
    path.join(root, "charter/policies/lifecycle.md"),
    `# Lifecycle\n\nTrips to ${secretPlace} are noted.\n${privateSentence}\nseparator text that only the template carries\n${quotedPolicy}\n`,
  );
  const result = check(["--root", root, "--private", workspace]);
  assert.deepEqual(result.findings.sort(), [
    "charter/policies/lifecycle.md:private-term",
    // The 14-word private sentence holds 3 runs; the quoted policy's runs are generic.
    "charter/policies/lifecycle.md:shares-3-12-word-runs",
  ]);
  assert.doesNotMatch(result.stderr, new RegExp(secretPlace));
  assert.doesNotMatch(result.stderr, /harbour/);
  // CI mode knows nothing private and passes the same tree.
  assert.equal(check(["--root", root]).code, 0);
});

test("seeding creates the workspace once and never replaces a file the user has", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-seed-"));
  await mkdir(path.join(root, "charter"), { recursive: true });
  await writeFile(path.join(root, "charter/core.md"), "# mine\n");
  const first = await seedWorkspaceTemplate(root, TEMPLATE);
  assert.ok(first.created.includes("charter/policies/task.md"));
  assert.ok(first.created.includes("02-personal/MEMORY.md"));
  assert.deepEqual(first.kept, ["charter/core.md"]);
  assert.equal(
    await readFile(path.join(root, "charter/core.md"), "utf8"),
    "# mine\n",
  );
  const { stat } = await import("node:fs/promises");
  assert.ok((await stat(path.join(root, "00-inbox/candidates"))).isDirectory());
  await assert.rejects(stat(path.join(root, "01-daily/.gitkeep")));
  const second = await seedWorkspaceTemplate(root, TEMPLATE);
  assert.deepEqual(second.created, []);
});

test("a workspace seeded from the template has every root and resolvable governance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-seeded-"));
  await seedWorkspaceTemplate(root, TEMPLATE);
  const env = {
    ...process.env,
    OCEAN_ROOT: root,
    OCEAN_SKIP_DEPENDENCY_AUDIT: "1",
  };
  const doctor = spawnSync(
    process.execPath,
    [path.resolve("dist/main.js"), "doctor", "--json"],
    { env, encoding: "utf8" },
  );
  const codes = JSON.parse(doctor.stdout).findings.map((f) => f.code);
  for (const code of ["ROOT_MISSING", "GOVERNANCE_MISSING", "BROKEN_LINK"])
    assert.ok(!codes.includes(code), `${code} in ${codes}`);
  const policies = spawnSync(
    process.execPath,
    [path.resolve("dist/main.js"), "policy", "doctor"],
    { env, encoding: "utf8" },
  );
  assert.equal(JSON.parse(policies.stdout).ok, true, policies.stdout);
});

test("--optional passes only a tree without the template; a present one is still checked", async () => {
  const empty = await mkdtemp(path.join(os.tmpdir(), "ocean-no-template-"));
  assert.equal(check(["--root", empty, "--optional"]).code, 0);
  assert.notEqual(check(["--root", empty]).code, 0);
  const root = await copyTemplate();
  await writeFile(path.join(root, "01-daily/.gitkeep"), "x");
  assert.equal(check(["--root", root, "--optional"]).code, 1);
});
