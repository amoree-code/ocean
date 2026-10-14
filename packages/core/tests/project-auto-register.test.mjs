import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  autoRegisterProject,
  bindProject,
  projectSlug,
  renameProject,
  resolveProject,
  unbindProjectPath,
} from "../dist/application/context/project-resolution.js";
import { claudeSessionStartHook } from "../dist/application/hooks/session-start-hook.js";
import { PROJECTS_DIR, SYSTEM_DIR } from "../dist/paths.js";

// OCEAN_ROOT and one code root, both throwaway. A repo is a folder with a .git entry.
async function withWorkspace(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-auto-root-"));
  const code = await mkdtemp(path.join(os.tmpdir(), "ocean-auto-code-"));
  const saved = {
    root: process.env.OCEAN_ROOT,
    code: process.env.OCEAN_CODE_ROOTS,
    auto: process.env.OCEAN_AUTO_REGISTER,
  };
  process.env.OCEAN_ROOT = root;
  process.env.OCEAN_CODE_ROOTS = code;
  delete process.env.OCEAN_AUTO_REGISTER;
  const restore = (name, value) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  try {
    await run({ root, code });
  } finally {
    restore("OCEAN_ROOT", saved.root);
    restore("OCEAN_CODE_ROOTS", saved.code);
    restore("OCEAN_AUTO_REGISTER", saved.auto);
  }
}

async function repo(parent, ...segments) {
  const dir = path.join(parent, ...segments);
  await mkdir(path.join(dir, ".git"), { recursive: true });
  await mkdir(path.join(dir, "src"), { recursive: true });
  return dir;
}

const folder = (root, id) => path.join(root, PROJECTS_DIR, id);

test("slugs are lowercase project ids", () => {
  assert.equal(projectSlug("Ocean-UIUX-MCP"), "ocean-uiux-mcp");
  assert.equal(projectSlug("My App (v2)"), "my-app-v2");
  assert.equal(projectSlug("..hidden"), "hidden");
  assert.doesNotMatch(projectSlug(`${"a".repeat(63)}-bbbb`), /[-._]$/);
});

test("the first session in an unregistered repo registers it as a project", async () => {
  await withWorkspace(async ({ root, code }) => {
    const app = await repo(code, "acme", "My-App");
    const result = await autoRegisterProject(path.join(app, "src"));
    const { resolution, ...registered } = result;
    assert.deepEqual(registered, {
      status: "registered",
      projectId: "my-app",
      path: app,
    });
    assert.equal(resolution.status, "bound");
    assert.equal(resolution.projectId, "my-app");
    const manifest = JSON.parse(
      await readFile(path.join(folder(root, "my-app"), "project.json"), "utf8"),
    );
    assert.equal(manifest.autoRegistered, true);
    assert.ok(
      (await stat(path.join(folder(root, "my-app"), "tasks"))).isDirectory(),
    );
    assert.match(
      await readFile(path.join(folder(root, "my-app"), "MEMORY.md"), "utf8"),
      /my-app/,
    );
    assert.equal((await resolveProject(app)).projectId, "my-app");
    assert.equal((await autoRegisterProject(app)).status, "skipped");
  });
});

test("the session-start hook registers and reports the new project", async () => {
  await withWorkspace(async ({ code }) => {
    const app = await repo(code, "billing");
    const result = await claudeSessionStartHook({ cwd: path.join(app, "src") });
    assert.match(
      result.hookSpecificOutput.additionalContext,
      /project=billing confidence=high/,
    );
  });
});

test("auto-register skips everything it must not guess at", async () => {
  await withWorkspace(async ({ root, code }) => {
    const plain = path.join(code, "notes");
    await mkdir(plain, { recursive: true });
    assert.match(
      (await autoRegisterProject(plain)).reason,
      /not inside a git repository/,
    );

    const outside = await repo(
      await mkdtemp(path.join(os.tmpdir(), "ocean-elsewhere-")),
      "x",
    );
    assert.match(
      (await autoRegisterProject(outside)).reason,
      /outside the code roots/,
    );

    await mkdir(path.join(code, ".git"));
    assert.match(
      (await autoRegisterProject(code)).reason,
      /is a code root itself/,
      "a code root that is itself a repo is not a project",
    );

    process.env.OCEAN_CODE_ROOTS = path.dirname(root);
    await mkdir(path.join(root, ".git"), { recursive: true });
    assert.match(
      (await autoRegisterProject(root)).reason,
      /already bound|inside the Ocean workspace/,
    );
    process.env.OCEAN_CODE_ROOTS = code;

    await mkdir(folder(root, "taken"), { recursive: true });
    assert.match(
      (await autoRegisterProject(await repo(code, "Taken"))).reason,
      /04-projects\/taken already exists/,
    );

    process.env.OCEAN_AUTO_REGISTER = "0";
    assert.match(
      (await autoRegisterProject(await repo(code, "off"))).reason,
      /disabled/,
    );
  });
});

test("the temp dir is skipped when the code root is outside it", async () => {
  await withWorkspace(async () => {
    process.env.OCEAN_CODE_ROOTS = path.parse(os.tmpdir()).root;
    const temp = await repo(
      await mkdtemp(path.join(os.tmpdir(), "ocean-tmp-")),
      "scratch",
    );
    assert.match(
      (await autoRegisterProject(temp)).reason,
      /inside the temp directory/,
    );
  });
});

test("two sessions opening the same new repo register it once", async () => {
  await withWorkspace(async ({ root, code }) => {
    const app = await repo(code, "race");
    const results = await Promise.all([
      autoRegisterProject(app),
      autoRegisterProject(app),
    ]);
    assert.ok(results.some((result) => result.status === "registered"));
    const manifest = JSON.parse(
      await readFile(path.join(folder(root, "race"), "project.json"), "utf8"),
    );
    assert.equal(manifest.paths.length, 1);
  });
});

test("unbind removes the path and keeps the folder", async () => {
  await withWorkspace(async ({ root, code }) => {
    const app = await repo(code, "wrong");
    await autoRegisterProject(app);
    const { removed } = await unbindProjectPath(app);
    assert.equal(removed?.id, "wrong");
    assert.equal((await resolveProject(app)).status, "unbound");
    assert.ok((await stat(folder(root, "wrong"))).isDirectory());
    assert.equal((await unbindProjectPath(app)).removed, null);
  });
});

test("rename moves a project without tasks and refuses one with tasks", async () => {
  await withWorkspace(async ({ root, code }) => {
    const app = await repo(code, "tmp-name");
    await autoRegisterProject(app);
    await renameProject("tmp-name", "good-name");
    assert.equal((await resolveProject(app)).projectId, "good-name");
    const manifest = JSON.parse(
      await readFile(
        path.join(folder(root, "good-name"), "project.json"),
        "utf8",
      ),
    );
    assert.equal(manifest.name, "good-name");

    await bindProject("other", await repo(code, "other"));
    await assert.rejects(renameProject("good-name", "other"), /already exists/);
    await mkdir(path.join(folder(root, "good-name"), "tasks", "T-001"), {
      recursive: true,
    });
    await writeFile(
      path.join(folder(root, "good-name"), "tasks", "T-001", "task.md"),
      "---\nid: T-001\n---\n",
    );
    await assert.rejects(renameProject("good-name", "final"), /has tasks/);
  });
});

async function worktreeOf(main, parent, name) {
  const dir = path.join(parent, name);
  await mkdir(path.join(main, ".git", "worktrees", name), { recursive: true });
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, ".git"),
    `gitdir: ${path.join(main, ".git", "worktrees", name)}\n`,
  );
  return dir;
}

test("a linked worktree belongs to its main repo's project, never a new one", async () => {
  await withWorkspace(async ({ root, code }) => {
    const shop = await repo(code, "shop");
    await autoRegisterProject(shop);
    const wt = await worktreeOf(
      shop,
      path.join(code, "shop-worktrees"),
      "fix-login",
    );
    assert.equal((await resolveProject(wt)).projectId, "shop");
    const hook = await claudeSessionStartHook({ cwd: wt });
    assert.match(hook.hookSpecificOutput.additionalContext, /project=shop /);
    await assert.rejects(stat(folder(root, "fix-login")), /ENOENT/);

    const lonely = await repo(code, "lonely");
    const lonelyWt = await worktreeOf(lonely, path.join(code, "wts"), "x");
    assert.match(
      (await autoRegisterProject(lonelyWt)).reason,
      /linked worktree or submodule/,
    );
  });
});

test("every racing session ends up bound, not only the winner", async () => {
  await withWorkspace(async ({ code }) => {
    const app = await repo(code, "racer");
    const hooks = await Promise.all(
      Array.from({ length: 4 }, () => claudeSessionStartHook({ cwd: app })),
    );
    for (const hook of hooks)
      assert.match(hook.hookSpecificOutput.additionalContext, /project=racer /);
  });
});

test("explicit register ignores the automatic limits but not the hard rules", async () => {
  await withWorkspace(async ({ root }) => {
    process.env.OCEAN_AUTO_REGISTER = "0";
    const elsewhere = await repo(
      await mkdtemp(path.join(os.tmpdir(), "ocean-explicit-")),
      "api",
    );
    assert.equal((await autoRegisterProject(elsewhere)).status, "skipped");
    const result = await autoRegisterProject(elsewhere, { explicit: true });
    assert.equal(result.status, "registered");
    assert.equal(result.resolution.projectId, "api");
    await mkdir(path.join(root, "inner", ".git"), { recursive: true });
    assert.match(
      (await autoRegisterProject(path.join(root, "inner"), { explicit: true }))
        .reason,
      /already bound|inside the Ocean workspace/,
    );
  });
});

test("unbind works from anywhere inside the repo", async () => {
  await withWorkspace(async ({ code }) => {
    const app = await repo(code, "deep");
    await autoRegisterProject(app);
    assert.equal(
      (await unbindProjectPath(path.join(app, "src"))).removed?.id,
      "deep",
    );
    assert.equal((await resolveProject(app)).status, "unbound");
  });
});

test("rename ignores dotfiles in tasks/ and renames the memory heading", async () => {
  await withWorkspace(async ({ root, code }) => {
    await autoRegisterProject(await repo(code, "draft"));
    await writeFile(path.join(folder(root, "draft"), "tasks", ".DS_Store"), "");
    await renameProject("draft", "final");
    assert.match(
      await readFile(path.join(folder(root, "final"), "MEMORY.md"), "utf8"),
      /^# final — memory/,
    );
  });
});

test("a corrupt legacy bindings file never costs a session its bootstrap", async () => {
  await withWorkspace(async ({ root, code }) => {
    const registry = path.join(root, SYSTEM_DIR, "registry");
    await mkdir(registry, { recursive: true });
    await writeFile(path.join(registry, "project-bindings.json"), "{bad");
    const app = await repo(code, "survivor");
    const hook = await claudeSessionStartHook({ cwd: app });
    assert.match(
      hook.hookSpecificOutput.additionalContext,
      /^ocean=1 project=/,
    );
    await assert.rejects(
      bindProject("other", await repo(code, "other")),
      /JSON/,
      "writers never overwrite a file they cannot read",
    );
    assert.equal(
      await readFile(path.join(registry, "project-bindings.json"), "utf8"),
      "{bad",
    );
  });
});
