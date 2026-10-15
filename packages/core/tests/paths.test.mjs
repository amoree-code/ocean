import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  enginePath,
  engineRoot,
  oceanPath,
  oceanRoot,
  PERSONAL_DIR,
  PROJECTS_DIR,
  projectFolder,
  projectOfTasksRoot,
  resolveWithin,
  sameProject,
} from "../dist/paths.js";

test("engineRoot resolves to the engine package directory, one level above this module", () => {
  assert.equal(engineRoot(), path.resolve(import.meta.dirname, ".."));
});

test("default oceanRoot resolves to the private workspace sibling of engine, not inside it", () => {
  delete process.env.OCEAN_ROOT;
  assert.equal(oceanRoot(), path.resolve(engineRoot(), "..", "..", ".."));
  assert.notEqual(oceanRoot(), engineRoot());
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
