import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { isValidProjectId } from "@ocean/core/domain/context/project-id.js";
import {
  enginePath,
  engineRoot,
  listProjectDirs,
  oceanPath,
  oceanRoot,
  PERSONAL_DIR,
  PROJECTS_DIR,
  projectDir,
  projectFolder,
  projectOfTasksRoot,
  projectPathParts,
  registerEngineRoot,
  repoRoot,
  resolveWithin,
  sameProject,
  withoutProjectCategory,
} from "@ocean/core/shared/paths.js";

test("engineRoot resolves to the engine package directory, one level above this module", () => {
  assert.equal(engineRoot(), path.resolve(import.meta.dirname, ".."));
});

async function withEngineAt(engine, check) {
  const previous = engineRoot();
  const previousRoot = process.env.OCEAN_ROOT;
  delete process.env.OCEAN_ROOT;
  try {
    registerEngineRoot(engine);
    await check();
  } finally {
    registerEngineRoot(previous);
    if (previousRoot === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previousRoot;
  }
}

test("a dev checkout inside a workspace serves that workspace by default", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ocean-checkout-"));
  await mkdir(path.join(workspace, "04-projects"));
  const engine = path.join(workspace, "kernel", "packages", "harness");
  await withEngineAt(engine, () => {
    assert.equal(engineRoot(), engine);
    assert.equal(oceanRoot(), workspace);
    assert.equal(repoRoot(), path.join(workspace, "kernel"));
  });
});

test("an engine outside any workspace (a global npm install) defaults to ~/ocean", async () => {
  const prefix = await mkdtemp(path.join(os.tmpdir(), "ocean-npm-prefix-"));
  const engine = path.join(
    prefix,
    "lib",
    "node_modules",
    "@ameer.abdulkareem",
    "ocean",
  );
  await withEngineAt(engine, () => {
    assert.equal(oceanRoot(), path.join(os.homedir(), "ocean"));
    assert.notEqual(oceanRoot(), engineRoot());
  });
});

test("the CLI's engine-root module sets core's engineRoot from wherever the ocean package is installed", async () => {
  // An installed ocean package is not a sibling of @ocean/core; copy engine-root.js elsewhere.
  const installed = await mkdtemp(path.join(os.tmpdir(), "ocean-installed-"));
  await mkdir(path.join(installed, "dist"));
  await copyFile(
    path.resolve("dist/engine-root.js"),
    path.join(installed, "dist", "engine-root.js"),
  );
  const script = [
    `await import(${JSON.stringify(pathToFileURL(path.join(installed, "dist", "engine-root.js")).href)});`,
    `const paths = await import("@ocean/core/shared/paths.js");`,
    "console.log(paths.engineRoot());",
  ].join("\n");
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { encoding: "utf8" },
  );
  // Both sides through realpath: macOS /var vs /private/var, Windows 8.3 short names.
  assert.equal(await realpath(output.trim()), await realpath(installed));
});

test("OCEAN_ROOT explicitly overrides the default private root", () => {
  const override = path.join(os.tmpdir(), "ocean-root-override");
  process.env.OCEAN_ROOT = override;
  try {
    assert.equal(oceanRoot(), path.resolve(override));
    assert.equal(
      oceanPath(PERSONAL_DIR),
      path.join(path.resolve(override), PERSONAL_DIR),
    );
    assert.equal(
      oceanPath("sessions", "sessions.sqlite"),
      path.join(path.resolve(override), "sessions", "sessions.sqlite"),
    );
  } finally {
    delete process.env.OCEAN_ROOT;
  }
});

test("enginePath always resolves relative to engine root, ignoring OCEAN_ROOT", () => {
  process.env.OCEAN_ROOT = path.join(os.tmpdir(), "ocean-root-unrelated");
  try {
    assert.equal(
      enginePath("dist", "main.js"),
      path.join(engineRoot(), "dist", "main.js"),
    );
  } finally {
    delete process.env.OCEAN_ROOT;
  }
});

test("resolveWithin allows an ordinary path inside its root, existing or not", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-resolve-within-"));
  await writeFile(path.join(root, "existing.txt"), "hi");
  assert.equal(
    resolveWithin(root, "existing.txt"),
    path.join(root, "existing.txt"),
  );
  assert.equal(
    resolveWithin(root, "not-yet-created", "target.txt"),
    path.join(root, "not-yet-created", "target.txt"),
  );
});

test("resolveWithin rejects lexical traversal out of its root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-resolve-within-"));
  assert.throws(
    () => resolveWithin(root, "..", "outside.txt"),
    /Path escapes its allowed root/,
  );
});

test("resolveWithin rejects a symlink inside its root that points outside it", async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "ocean-outside-"));
  await writeFile(path.join(outside, "secret.txt"), "secret");
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-resolve-within-"));
  await symlink(outside, path.join(root, "escape-link"));

  assert.throws(
    () => resolveWithin(root, "escape-link", "secret.txt"),
    /Path escapes its allowed root/,
  );
});

test("resolveWithin allows a symlink inside its root that points elsewhere inside it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-resolve-within-"));
  await mkdir(path.join(root, "real-target"));
  await writeFile(path.join(root, "real-target", "file.txt"), "hi");
  await symlink(
    path.join(root, "real-target"),
    path.join(root, "internal-link"),
  );

  assert.doesNotThrow(() => resolveWithin(root, "internal-link", "file.txt"));
});

async function projectsRoot(...folders) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-project-folder-"));
  for (const folder of folders)
    await mkdir(path.join(root, PROJECTS_DIR, folder), { recursive: true });
  return root;
}

test("other projects keep their own folder name untouched, and only the workspace aliases compare equal", async () => {
  const root = await projectsRoot("ocean/tasks");
  assert.equal(projectFolder("ocean-language", root), "ocean-language");
  assert.equal(projectFolder("freelance/acme", root), "freelance/acme");
  assert.equal(sameProject("Ocean", "ocean"), true);
  assert.equal(sameProject("legacy", "ocean"), false);
  assert.equal(sameProject("ocean", "ocean-language"), false);
  assert.equal(sameProject("acme", "acme"), true);
});

test("projectOfTasksRoot inverts a project's tasks root and nothing else", async () => {
  assert.equal(
    projectOfTasksRoot(oceanPath(PROJECTS_DIR, "lab", "tasks")),
    "lab",
  );
  assert.equal(projectOfTasksRoot(oceanPath(PROJECTS_DIR, "lab")), null);
  assert.equal(
    projectOfTasksRoot(oceanPath(PROJECTS_DIR, "lab", "tasks", "x", "tasks")),
    null,
  );
  assert.equal(projectOfTasksRoot("/elsewhere/lab/tasks"), null);
  assert.equal(
    projectOfTasksRoot(oceanPath(PROJECTS_DIR, "Bad Id", "tasks")),
    null,
  );
});

test("projectOfTasksRoot accepts a project inside a category folder, and no other nesting", () => {
  assert.equal(
    projectOfTasksRoot(oceanPath(PROJECTS_DIR, "company", "lab", "tasks")),
    "lab",
  );
  assert.equal(
    projectOfTasksRoot(
      oceanPath(PROJECTS_DIR, "uncategorized", "lab", "tasks"),
    ),
    "lab",
  );
  assert.equal(
    projectOfTasksRoot(oceanPath(PROJECTS_DIR, "elsewhere", "lab", "tasks")),
    null,
  );
});

test("a category folder name is never a project id (T-311)", () => {
  for (const name of [
    "company",
    "personal",
    "freelance",
    "former-company",
    "vendor",
    "uncategorized",
  ])
    assert.equal(isValidProjectId(name), false, name);
  assert.equal(isValidProjectId("company-site"), true);
});

test("listProjectDirs reads category folders and flat folders, and skips the rest (T-311)", async () => {
  const root = await projectsRoot(
    "company/crm",
    "personal/ocean",
    "uncategorized/new-one",
    "legacy",
    "_project",
    ".hidden",
    "elsewhere/nested",
  );
  await writeFile(path.join(root, PROJECTS_DIR, "registry.md"), "");
  assert.deepEqual(listProjectDirs(root), [
    { id: "crm", category: "company", dir: `${PROJECTS_DIR}/company/crm` },
    { id: "elsewhere", dir: `${PROJECTS_DIR}/elsewhere` },
    { id: "legacy", dir: `${PROJECTS_DIR}/legacy` },
    {
      id: "new-one",
      category: "uncategorized",
      dir: `${PROJECTS_DIR}/uncategorized/new-one`,
    },
    {
      id: "ocean",
      category: "personal",
      dir: `${PROJECTS_DIR}/personal/ocean`,
    },
  ]);
  assert.deepEqual(listProjectDirs(path.join(root, "missing")), []);
});

test("projectDir finds a project in either layout, and places a new one (T-311)", async () => {
  const root = await projectsRoot("company/crm", "legacy");
  assert.equal(projectDir("crm", root), `${PROJECTS_DIR}/company/crm`);
  assert.equal(projectDir("legacy", root), `${PROJECTS_DIR}/legacy`);
  assert.equal(
    projectDir("brand-new", root),
    `${PROJECTS_DIR}/uncategorized/brand-new`,
  );
  // The workspace's own project is the owner's: personal, under any of its aliases.
  assert.equal(projectDir("Ocean", root), `${PROJECTS_DIR}/personal/ocean`);
  // Not an id: left as written, for the caller's own checks to refuse.
  assert.equal(projectDir("..", root), path.posix.join(PROJECTS_DIR, ".."));
});

test("a path written in either layout names the same project", () => {
  assert.deepEqual(projectPathParts(["crm", "memory", "a.md"]), {
    id: "crm",
    rest: ["memory", "a.md"],
  });
  assert.deepEqual(projectPathParts(["company", "crm", "memory", "a.md"]), {
    id: "crm",
    rest: ["memory", "a.md"],
  });
  assert.deepEqual(projectPathParts(["company"]), null);
  assert.deepEqual(projectPathParts(["Bad Id", "memory"]), null);
  assert.equal(
    withoutProjectCategory(`${PROJECTS_DIR}/company/crm/memory/a.md`),
    `${PROJECTS_DIR}/crm/memory/a.md`,
  );
  assert.equal(
    withoutProjectCategory(`${PROJECTS_DIR}/crm/memory/a.md`),
    `${PROJECTS_DIR}/crm/memory/a.md`,
  );
  assert.equal(withoutProjectCategory("02-personal/x.md"), "02-personal/x.md");
});

test("one id in two folders: listProjectDirs puts first the folder projectDir picks", async () => {
  const root = await projectsRoot("uncategorized/twin", "vendor/twin", "twin");
  assert.equal(projectDir("twin", root), `${PROJECTS_DIR}/vendor/twin`);
  assert.deepEqual(
    listProjectDirs(root).map((entry) => entry.dir),
    [
      `${PROJECTS_DIR}/vendor/twin`,
      `${PROJECTS_DIR}/uncategorized/twin`,
      `${PROJECTS_DIR}/twin`,
    ],
  );
});
