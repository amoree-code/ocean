import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bindProject,
  canonicalPath,
  expandHome,
  listProjectBindings,
  listProjectManifests,
  migrateProjectBindings,
  portablePath,
  readProjectManifest,
  renameProject,
  resolveProject,
  scanProjectManifests,
  unbindProjectPath,
  withNextTaskId,
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
      portablePath(canonicalPath(dashboard)),
      portablePath(canonicalPath(backend)),
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
    assert.deepEqual(manifest.paths, [portablePath(canonicalPath(kept))]);
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

test("an invalid manifest takes only its own project out of resolution, and is reported", async () => {
  await withRoot(async (root) => {
    const good = await mkdtemp(path.join(os.tmpdir(), "ocean-good-"));
    await bindProject("good", good);
    for (const [folder, body] of [
      ["broken", JSON.stringify({ paths: "not-a-list" })],
      ["truncated", "{bad"],
    ]) {
      await mkdir(path.join(projects(root), folder), { recursive: true });
      await writeFile(path.join(projects(root), folder, "project.json"), body);
    }
    const scan = await scanProjectManifests();
    assert.deepEqual(
      scan.manifests.map((manifest) => manifest.id),
      ["good"],
    );
    assert.deepEqual(
      scan.errors.map((entry) => path.basename(path.dirname(entry.file))),
      ["broken", "truncated"],
    );
    assert.equal((await resolveProject(good)).projectId, "good");
  });
});

test("project ids are lowercase so one folder never has two ids", async () => {
  await withRoot(async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "ocean-case-"));
    await bindProject("ocean-language", repo);
    await assert.rejects(
      bindProject("Ocean-Language", os.tmpdir(), { addPath: true }),
      /Invalid project id/,
    );
  });
});

test("re-binding a project's own legacy path folds it in, without a conflict", async () => {
  await withRoot(async (root) => {
    const p = await mkdtemp(path.join(os.tmpdir(), "ocean-p-"));
    const q = await mkdtemp(path.join(os.tmpdir(), "ocean-q-"));
    await bindProject("demo", q);
    await writeLegacy(root, [
      { id: "demo", name: "demo", path: p, gitRoot: null, boundAt: "t0" },
    ]);
    const result = await bindProject("demo", p);
    assert.equal(result.conflict, undefined);
    assert.deepEqual((await manifestOf(root, "demo")).paths, [
      portablePath(canonicalPath(q)),
      portablePath(canonicalPath(p)),
    ]);
  });
});

test("the cache keeps a legacy entry after a manifest claims its path", async () => {
  await withRoot(async (root) => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "ocean-cache-"));
    await mkdir(path.join(projects(root), "kept"), { recursive: true });
    await writeLegacy(root, [
      { id: "kept", name: "kept", path: repo, gitRoot: null, boundAt: "t0" },
    ]);
    await bindProject("kept", repo);
    const cache = JSON.parse(
      await readFile(
        path.join(root, SYSTEM_DIR, "registry", "project-bindings.json"),
        "utf8",
      ),
    );
    assert.ok(cache.bindings.some((entry) => !entry.manifest));
    await rm(path.join(projects(root), "kept"), { recursive: true });
    assert.equal((await resolveProject(repo)).projectId, "kept");
  });
});

test("migrate reports a legacy id that is not a valid folder name", async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(projects(root)), { recursive: true });
    await writeLegacy(root, [
      { id: "", name: "", path: "/x", gitRoot: null, boundAt: "t0" },
      {
        id: "../../bridge",
        name: "x",
        path: "/y",
        gitRoot: null,
        boundAt: "t0",
      },
    ]);
    const result = await migrateProjectBindings(true);
    assert.equal(result.migrated.length, 0);
    assert.equal(result.orphaned.length, 2);
    await assert.rejects(
      readFile(path.join(projects(root), "project.json")),
      /ENOENT/,
    );
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
    await writeFile(
      path.join(projects(root), "alpha", "project.json"),
      JSON.stringify({ name: "Dash | API\nv2", paths: [] }),
    );
    await writeProjectIndex();
    assert.match(
      await readFile(registry, "utf8"),
      /\| `alpha` \| Dash \\\| API v2 \| — \|/,
    );
    await bindProject("alpha", repo);
    await writeProjectIndex();

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

test("a repo bound through a symlink resolves from its real path, and back", async () => {
  await withRoot(async () => {
    const real = await mkdtemp(path.join(os.tmpdir(), "ocean-real-"));
    const link = path.join(
      await mkdtemp(path.join(os.tmpdir(), "ocean-link-")),
      "repo",
    );
    await symlink(real, link);
    await bindProject("linked", link);
    assert.equal(
      (await resolveProject(path.join(realpathSync(real)))).projectId,
      "linked",
    );
    assert.equal((await resolveProject(link)).projectId, "linked");
  });
});

async function writeRaw(root, folder, body) {
  await mkdir(path.join(projects(root), folder), { recursive: true });
  await writeFile(
    path.join(projects(root), folder, "project.json"),
    JSON.stringify({ name: folder, paths: [], ...body }),
  );
}

test("valid rules and verify parse, trimmed", async () => {
  await withRoot(async (root) => {
    await writeRaw(root, "lab", {
      rules: ["  .env points at production  ", "never run migrations"],
      verify: ["pnpm test"],
    });
    const manifest = await readProjectManifest("lab");
    assert.deepEqual(manifest.rules, [
      ".env points at production",
      "never run migrations",
    ]);
    assert.deepEqual(manifest.verify, ["pnpm test"]);
    assert.equal(await readProjectManifest("missing"), null);
  });
});

test("each invalid rules/verify shape is a scan error naming the field", async () => {
  await withRoot(async (root) => {
    const bad = {
      "bare-rules": [{ rules: "no" }, /rules must be a list/],
      "many-rules": [
        { rules: Array.from({ length: 11 }, (_, i) => `r${i}`) },
        /rules holds at most 10/,
      ],
      "empty-rule": [{ rules: ["  "] }, /rules\[0\]/],
      "number-rule": [{ rules: [3] }, /rules\[0\]/],
      "multi-rule": [{ rules: ["a\nb"] }, /rules\[0\] must be a single line/],
      "long-rule": [
        { rules: ["é".repeat(101)] },
        /rules\[0\] exceeds 200 bytes/,
      ],
      "bare-verify": [{ verify: "pnpm test" }, /verify must be a list/],
      "many-verify": [
        { verify: ["a", "b", "c", "d", "e", "f"] },
        /verify holds at most 5/,
      ],
      "long-verify": [
        { verify: ["x".repeat(301)] },
        /verify\[0\] exceeds 300 bytes/,
      ],
      "multi-verify": [
        { verify: ["a\rb"] },
        /verify\[0\] must be a single line/,
      ],
    };
    for (const [folder, [body]] of Object.entries(bad))
      await writeRaw(root, folder, body);
    const scan = await scanProjectManifests();
    assert.deepEqual(scan.manifests, []);
    for (const entry of scan.errors) {
      const folder = path.basename(path.dirname(entry.file));
      assert.match(entry.error, bad[folder][1], folder);
    }
    assert.equal(scan.errors.length, Object.keys(bad).length);
    await assert.rejects(readProjectManifest("bare-rules"), /rules must be/);
  });
});

test("rules and verify survive bind --add, unbind, rename, withNextTaskId and renumber", async () => {
  await withRoot(async (root) => {
    const repos = await mkdtemp(path.join(os.tmpdir(), "ocean-repos-"));
    const a = path.join(repos, "a");
    const b = path.join(repos, "b");
    await mkdir(a);
    await mkdir(b);
    await bindProject("lab", a);
    const file = path.join(projects(root), "lab", "project.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    await writeFile(
      file,
      JSON.stringify({
        ...manifest,
        rules: ["keep me"],
        verify: ["pnpm test"],
      }),
    );
    const keeps = async (label) => {
      const now = await manifestOf(root, label);
      assert.deepEqual(now.rules, ["keep me"], label);
      assert.deepEqual(now.verify, ["pnpm test"], label);
    };
    await bindProject("lab", b, { addPath: true });
    await keeps("lab");
    await unbindProjectPath(b);
    await keeps("lab");
    await withNextTaskId("lab", async () => ({ ok: true }));
    await keeps("lab");
    await renameProject("lab", "lab2");
    await keeps("lab2");
  });
});

test("tasks renumber --write keeps rules and verify", async () => {
  await withRoot(async (root) => {
    const dir = path.join(projects(root), "lab", "tasks", "T-5");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "task.md"),
      "---\nid: T-5\ntitle: t\nstate: active\nproject: lab\n---\n",
    );
    await mkdir(path.join(projects(root), "ocean"), { recursive: true });
    await writeFile(
      path.join(projects(root), "ocean", "project.json"),
      JSON.stringify({ name: "ocean", paths: [] }),
    );
    await writeRaw(root, "lab", { rules: ["keep me"], verify: ["pnpm test"] });
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("dist/main.js"),
        "tasks",
        "renumber",
        "--project",
        "lab",
        "--prefix",
        "LB",
        "--write",
      ],
      {
        cwd: root,
        env: { ...process.env, OCEAN_ROOT: root },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const now = await manifestOf(root, "lab");
    assert.equal(now.prefix, "LB");
    assert.deepEqual(now.rules, ["keep me"]);
    assert.deepEqual(now.verify, ["pnpm test"]);
  });
});
