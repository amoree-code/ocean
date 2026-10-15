import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveTaskReference } from "../dist/application/tasks/task-reference.js";
import { PROJECTS_DIR } from "../dist/paths.js";

// ocean: T-1 live, T-2 archived. shop: T-101, T-1 (also held by ocean). app (AP): AP-001.
// lab (LB): LB-001 renamed from T-300, LB-002 archived and renamed from T-301.
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-reference-"));
  process.env.OCEAN_ROOT = root;
  const write = async (project, parts, fields = {}) => {
    const dir = path.join(root, PROJECTS_DIR, project, "tasks", ...parts);
    await mkdir(dir, { recursive: true });
    const id = parts.at(-1);
    const extra = Object.entries(fields)
      .map(([key, value]) => `${key}: ${value}\n`)
      .join("");
    await writeFile(
      path.join(dir, "task.md"),
      `---\nid: ${id}\n${extra}state: active\n---\n`,
    );
  };
  const manifest = (project, extra = {}) =>
    mkdir(path.join(root, PROJECTS_DIR, project), { recursive: true }).then(
      () =>
        writeFile(
          path.join(root, PROJECTS_DIR, project, "project.json"),
          JSON.stringify({ name: project, paths: [], ...extra }),
        ),
    );
  await write("ocean", ["T-001"]);
  await write("ocean", ["archive", "Ocean", "T-002"]);
  await write("shop", ["T-101"]);
  await write("shop", ["T-001"]);
  await write("app", ["AP-001"]);
  await write("lab", ["LB-001"], { legacyId: "T-300" });
  await write("lab", ["archive", "lab", "LB-002"], { legacyId: "T-301" });
  await manifest("shop");
  await manifest("app", { prefix: "AP", nextTask: 2 });
  await manifest("lab", { prefix: "LB", nextTask: 3 });
  return root;
}
const rel = (root, file) => path.relative(root, file).split(path.sep).join("/");

test("a prefixed id routes to the project that owns the prefix", async () => {
  const root = await fixture();
  const hit = await resolveTaskReference("ap-1");
  assert.equal(hit.projectId, "app");
  assert.equal(hit.id, "AP-001");
  assert.equal(hit.archived, false);
  assert.equal(rel(root, hit.file), "04-projects/app/tasks/AP-001/task.md");
});

test("an unknown prefix and an unknown id say so", async () => {
  await fixture();
  await assert.rejects(
    resolveTaskReference("ZZ-1"),
    /no project uses prefix ZZ/,
  );
  await assert.rejects(
    resolveTaskReference("AP-9"),
    /AP-9 is not a task in project app/,
  );
  await assert.rejects(resolveTaskReference("nonsense"), /not a task id/);
});

test("a bare T id resolves in the current project first, live then archive", async () => {
  await fixture();
  const own = await resolveTaskReference("T-1", { projectId: "shop" });
  assert.equal(own.projectId, "shop");
  assert.equal(own.id, "T-001");
  const archived = await resolveTaskReference("T-2", { projectId: "ocean" });
  assert.deepEqual([archived.projectId, archived.archived], ["ocean", true]);
});

test("the current project can come from a folder", async () => {
  await fixture();
  const repo = await mkdtemp(path.join(os.tmpdir(), "ocean-reference-repo-"));
  const { bindProject } = await import(
    "../dist/application/context/project-resolution.js"
  );
  await bindProject("shop", repo);
  const hit = await resolveTaskReference("T-1", { cwd: repo });
  assert.equal(hit.projectId, "shop");
});

test("without a current project one holder wins and several are ambiguous", async () => {
  await fixture();
  assert.equal((await resolveTaskReference("T-101")).projectId, "shop");
  await assert.rejects(
    resolveTaskReference("T-1"),
    /T-1 exists in ocean, shop; pass --project/,
  );
  const archived = await resolveTaskReference("T-2");
  assert.deepEqual([archived.projectId, archived.archived], ["ocean", true]);
});

test("a task renumbered since is found through legacyId, live and archived", async () => {
  await fixture();
  const live = await resolveTaskReference("T-300");
  assert.deepEqual(
    [live.projectId, live.id, live.archived],
    ["lab", "LB-001", false],
  );
  const old = await resolveTaskReference("T-301", { projectId: "lab" });
  assert.deepEqual([old.id, old.archived], ["LB-002", true]);
});

test("explicit project and a foreign prefix is an error naming the owner", async () => {
  await fixture();
  await assert.rejects(
    resolveTaskReference("AP-1", { projectId: "shop", explicit: true }),
    /AP-1 belongs to app, not shop/,
  );
  await assert.rejects(
    resolveTaskReference("AP-1", { projectId: "shop", acrossProjects: false }),
    /belongs to app/,
  );
});

test("an explicit project never falls back to another project", async () => {
  await fixture();
  await assert.rejects(
    resolveTaskReference("T-101", { projectId: "ocean", explicit: true }),
    /T-101 is not a task in project ocean/,
  );
});

test("acrossProjects false stays inside the project", async () => {
  await fixture();
  await assert.rejects(
    resolveTaskReference("T-101", {
      projectId: "ocean",
      acrossProjects: false,
    }),
    /T-101 is not a task in any project/,
  );
  await assert.rejects(
    resolveTaskReference("T-300", {
      projectId: "ocean",
      acrossProjects: false,
    }),
    /not a task/,
  );
  const hit = await resolveTaskReference("T-300", {
    projectId: "lab",
    acrossProjects: false,
  });
  assert.equal(hit.id, "LB-001");
});

test("an id nobody holds is reported as such", async () => {
  await fixture();
  await assert.rejects(
    resolveTaskReference("T-999"),
    /T-999 is not a task in any project/,
  );
});
