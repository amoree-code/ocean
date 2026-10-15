import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The layout is decided once per process from the root it loads with (T-243 phase 6), so each
// case loads paths.js in a fresh process against its own fixture root.
function layoutOf(dirs) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ocean-layout-"));
  try {
    for (const dir of dirs)
      mkdirSync(path.join(root, dir), { recursive: true });
    const script = `import("./dist/paths.js").then((p) => console.log(JSON.stringify({ personal: p.PERSONAL_DIR, projects: p.PROJECTS_DIR, charter: p.CHARTER_DIR, policies: p.POLICIES_DIR, records: p.BRAIN_RECORD_DIRS, system: p.SYSTEM_DIR, registry: p.REGISTRY_DIR, tasks: path.relative(process.env.OCEAN_ROOT, p.workspaceTasksRoot()).split(path.sep).join("/") })))`;
    return JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import path from "node:path"; ${script}`,
        ],
        {
          env: { PATH: process.env.PATH, OCEAN_ROOT: root },
          encoding: "utf8",
        },
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const FLAT = {
  personal: "02-personal",
  projects: "04-projects",
  charter: "charter",
  policies: "charter/policies",
  records: [
    "00-inbox",
    "01-daily",
    "02-personal",
    "03-professional",
    "05-knowledge",
    "06-templates",
  ],
  system: "bridge",
  registry: "bridge/registry",
};

test("a fresh root gets the flat layout", () => {
  assert.deepEqual(layoutOf([]), {
    ...FLAT,
    tasks: "04-projects/ocean/tasks",
  });
});

test("a root that has not been migrated keeps brain/ and kernel/bridge", () => {
  assert.deepEqual(
    layoutOf([
      "brain/04-projects/ocean/tasks",
      "brain/charter/policies",
      "kernel/bridge/sessions",
    ]),
    {
      personal: "brain/02-personal",
      projects: "brain/04-projects",
      charter: "brain/charter",
      policies: "brain/charter/policies",
      records: FLAT.records.map((dir) => `brain/${dir}`),
      system: "kernel/bridge",
      registry: "kernel/bridge/registry",
      tasks: "brain/04-projects/ocean/tasks",
    },
  );
});

test("while both layouts exist mid-migration, the new one wins", () => {
  assert.deepEqual(
    layoutOf([
      "brain/04-projects/ocean/tasks",
      "kernel/bridge/sessions",
      "04-projects/ocean/tasks",
      "bridge/sessions",
    ]),
    { ...FLAT, tasks: "04-projects/ocean/tasks" },
  );
});

test("each half moves on its own: the bridge can move before the records", () => {
  const layout = layoutOf(["brain/04-projects", "bridge/sessions"]);
  assert.equal(layout.projects, "brain/04-projects");
  assert.equal(layout.charter, "brain/charter");
  assert.equal(layout.system, "bridge");
});

test("an empty bridge/ created by accident does not hide the real kernel/bridge", () => {
  const layout = layoutOf(["bridge", "kernel/bridge/sessions"]);
  assert.equal(layout.system, "kernel/bridge");
});
