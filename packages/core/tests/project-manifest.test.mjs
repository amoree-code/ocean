import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bindProject,
  expandHome,
  listProjectBindings,
  listProjectManifests,
  migrateProjectBindings,
  portablePath,
  resolveProject,
  writeProjectIndex,
} from "../dist/application/context/project-resolution.js";
import { PROJECTS_DIR, SYSTEM_DIR } from "../dist/paths.js";

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-manifest-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

const projects = (root) => path.join(root, PROJECTS_DIR);
const manifestOf = async (root, id) =>
  JSON.parse(
    await readFile(path.join(projects(root), id, "project.json"), "utf8"),
  );

async function writeLegacy(root, bindings) {
  const dir = path.join(root, SYSTEM_DIR, "registry");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "project-bindings.json"),
    JSON.stringify({ version: 1, bindings }),
  );
}

test("paths are stored ~-relative and expanded on read", () => {
  const home = os.homedir();
  assert.equal(portablePath(path.join(home, "a", "b")), "~/a/b");
  assert.equal(portablePath(home), "~");
  assert.equal(portablePath("/opt/x"), path.resolve("/opt/x"));
  assert.equal(expandHome("~/a/b"), path.join(home, "a", "b"));
  assert.equal(expandHome("/opt/x"), "/opt/x");
});

test("bind writes project.json and one project resolves from several repos", async () => {
  await withRoot(async (root) => {
    const repos = await mkdtemp(path.join(os.tmpdir(), "ocean-repos-"));
    const dashboard = path.join(repos, "dashboard");
    const backend = path.join(repos, "backend");
    await mkdir(path.join(dashboard, "src"), { recursive: true });
    await mkdir(backend, { recursive: true });

    const first = await bindProject("ocean-language", dashboard);
    assert.equal(first.created, true);
    const refused = await bindProject("ocean-language", backend);
    assert.ok(refused.conflict, "a second path needs --add");
    const added = await bindProject("ocean-language", backend, {
      addPath: true,
    });
    assert.equal(added.created, true);

    const manifest = await manifestOf(root, "ocean-language");
    assert.deepEqual(manifest.paths, [
      portablePath(dashboard),
      portablePath(backend),
    ]);
    assert.equal(manifest.autoRegistered, false);
    for (const cwd of [path.join(dashboard, "src"), backend]) {
      const resolved = await resolveProject(cwd);
      assert.equal(resolved.status, "bound");
      assert.equal(resolved.projectId, "ocean-language");
    }
    const again = await bindProject("ocean-language", backend, {
      addPath: true,
    });
    assert.equal(again.created, false);
    assert.equal((await manifestOf(root, "ocean-language")).paths.length, 2);
  });
});

test("a path bound to one project is a conflict for another, even with --add", async () => {
  await withRoot(async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "ocean-repo-"));
    await bindProject("alpha", repo);
    const other = await bindProject("beta", repo, { addPath: true });
    assert.equal(other.conflict?.id, "alpha");
    assert.deepEqual(
      (await listProjectManifests()).map((manifest) => manifest.id),
      ["alpha"],
    );
  });
});

test("bind refuses a project id that is not one plain path segment", async () => {
  await withRoot(async () => {
    for (const bad of ["../escape", "a/b", "", ".hidden", "x..y"])
      await assert.rejects(bindProject(bad, os.tmpdir()), /Invalid project id/);
  });
});

test("the longest matching path wins across projects", async () => {
  await withRoot(async () => {
    const outer = await mkdtemp(path.join(os.tmpdir(), "ocean-outer-"));
    const inner = path.join(outer, "packages", "inner");
    await mkdir(inner, { recursive: true });
    await bindProject("outer", outer);
    await bindProject("inner", inner);
    assert.equal((await resolveProject(inner)).projectId, "inner");
    assert.equal((await resolveProject(outer)).projectId, "outer");
  });
});

test("legacy bindings still resolve until migrated; a manifest wins for the same path", async () => {
  await withRoot(async (root) => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "ocean-legacy-"));
    await writeLegacy(root, [
      {
        id: "old",
        name: "old",
        path: repo,
        gitRoot: null,
        boundAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
    assert.equal((await resolveProject(repo)).projectId, "old");
    await mkdir(path.join(projects(root), "new"), { recursive: true });
    await writeFile(
      path.join(projects(root), "new", "project.json"),
      JSON.stringify({ id: "new", name: "New", paths: [repo] }),
    );
    assert.equal((await resolveProject(repo)).projectId, "new");
    assert.equal((await listProjectBindings()).length, 1);
  });
});

test("migrate folds bindings into existing project folders and reports orphans", async () => {
  await withRoot(async (root) => {
    const kept = await mkdtemp(path.join(os.tmpdir(), "ocean-kept-"));
    const orphan = await mkdtemp(path.join(os.tmpdir(), "ocean-orphan-"));
    await mkdir(path.join(projects(root), "kept", "tasks"), {
      recursive: true,
    });
    await writeLegacy(root, [
      { id: "kept", name: "Kept", path: kept, gitRoot: null, boundAt: "t0" },
      {
        id: "gone",
        name: "gone",
        path: orphan,
        gitRoot: null,
        boundAt: "t1",
      },
    ]);
    const dry = await migrateProjectBindings(false);
    assert.deepEqual(
      dry.migrated.map((entry) => entry.id),
      ["kept"],
    );
    assert.deepEqual(
      dry.orphaned.map((entry) => entry.id),
      ["gone"],
    );
    assert.deepEqual(
      await listProjectManifests(),
      [],
      "dry run writes nothing",
    );

    const done = await migrateProjectBindings(true);
    assert.equal(done.written, true);
    const manifest = await manifestOf(root, "kept");
    assert.deepEqual(manifest.paths, [portablePath(kept)]);
    assert.equal(manifest.name, "Kept");
    assert.equal(
      (await migrateProjectBindings(true)).migrated.length,
      0,
      "a second run has nothing left to fold",
    );
    assert.equal((await resolveProject(orphan)).projectId, "gone");
    await assert.rejects(
      readFile(path.join(projects(root), "gone", "project.json")),
      /ENOENT/,
    );
  });
});

test("an invalid manifest fails loudly instead of being guessed at", async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(projects(root), "broken"), { recursive: true });
    await writeFile(
      path.join(projects(root), "broken", "project.json"),
      JSON.stringify({ id: "broken", paths: "not-a-list" }),
    );
    await assert.rejects(listProjectManifests(), /Invalid project manifest/);
  });
});

test("the folder name is the id, whatever the manifest claims", async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(projects(root), "real"), { recursive: true });
    await writeFile(
      path.join(projects(root), "real", "project.json"),
      JSON.stringify({ id: "spoofed", paths: [] }),
    );
    assert.deepEqual(
      (await listProjectManifests()).map((manifest) => manifest.id),
      ["real"],
    );
  });
});

test("index writes a managed block and keeps the hand-kept registry text", async () => {
  await withRoot(async (root) => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "ocean-index-"));
    await bindProject("alpha", repo);
    const registry = path.join(projects(root), "registry.md");
    const hand =
      "# Project registry\n\n| hand | kept |\n|---|---|\n| a | b |\n";
    await writeFile(registry, hand);

    assert.equal((await writeProjectIndex()).changed, true);
    const once = await readFile(registry, "utf8");
    assert.ok(once.startsWith(hand.trimEnd()), "hand-kept text untouched");
    assert.match(once, /<!-- ocean:projects:begin/);
    assert.match(once, /\| `alpha` \| alpha \|/);

    assert.equal((await writeProjectIndex()).changed, false, "idempotent");
    await bindProject(
      "beta",
      await mkdtemp(path.join(os.tmpdir(), "ocean-b-")),
    );
    await writeProjectIndex();
    const twice = await readFile(registry, "utf8");
    assert.equal((twice.match(/ocean:projects:begin/g) ?? []).length, 1);
    assert.match(twice, /\| `beta` \|/);
    assert.ok(twice.startsWith(hand.trimEnd()));
  });
});

test("index refuses to rewrite around a broken marker pair", async () => {
  await withRoot(async (root) => {
    const registry = path.join(projects(root), "registry.md");
    await mkdir(path.dirname(registry), { recursive: true });
    await writeFile(
      registry,
      "x\n<!-- ocean:projects:begin (generated by `ocean project index --write`) -->\n",
    );
    await assert.rejects(
      writeProjectIndex(),
      /unmatched ocean:projects marker/,
    );
  });
});

test("concurrent binds of different repos to one project keep every path", async () => {
  await withRoot(async (root) => {
    const repos = await Promise.all(
      Array.from({ length: 6 }, () =>
        mkdtemp(path.join(os.tmpdir(), "ocean-concurrent-")),
      ),
    );
    await bindProject("multi", repos[0]);
    await Promise.all(
      repos
        .slice(1)
        .map((repo) => bindProject("multi", repo, { addPath: true })),
    );
    assert.equal((await manifestOf(root, "multi")).paths.length, 6);
  });
});
