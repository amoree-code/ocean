import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PROJECTS_DIR } from "@ocean/core/shared/paths.js";
import {
  bindProject,
  knownTaskPrefixes,
  listProjectManifests,
  peekNextTaskId,
  projectForPrefix,
  withNextTaskId,
} from "@ocean/core/shared/project-resolution.js";

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-numbering-"));
  process.env.OCEAN_ROOT = root;
  return root;
}
const taskDir = (root, project, ...parts) =>
  path.join(root, PROJECTS_DIR, project, "tasks", ...parts);
const makeTask = (root, project, ...parts) =>
  mkdir(taskDir(root, project, ...parts), { recursive: true });
const writeManifest = (root, project, manifest) =>
  mkdir(path.join(root, PROJECTS_DIR, project), { recursive: true }).then(() =>
    writeFile(
      path.join(root, PROJECTS_DIR, project, "project.json"),
      JSON.stringify({ name: project, paths: [], ...manifest }),
    ),
  );

test("the scan reaches archive/<namespace>/<id>, so an archived id is never reissued", async () => {
  const root = await workspace();
  await makeTask(root, "ocean", "T-1");
  await makeTask(root, "ocean", "T-2");
  await makeTask(root, "ocean", "archive", "Ocean", "T-9");
  assert.equal(await peekNextTaskId("ocean"), "T-010");
});

test("a flat archive/<id> counts too", async () => {
  const root = await workspace();
  await makeTask(root, "ocean", "archive", "T-4");
  assert.equal(await peekNextTaskId("ocean"), "T-005");
});

test("the T scan spans every project, because the sequence was shared", async () => {
  const root = await workspace();
  await makeTask(root, "ocean", "T-3");
  await makeTask(root, "other", "T-40");
  await makeTask(root, "other", "archive", "other", "T-50");
  assert.equal(await peekNextTaskId("ocean"), "T-051");
});

test("zero padding to three digits; longer numbers stay as they are", async () => {
  const root = await workspace();
  assert.equal(await peekNextTaskId("ocean"), "T-001");
  await makeTask(root, "ocean", "T-266");
  assert.equal(await peekNextTaskId("ocean"), "T-267");
});

test("the counter beats a deleted folder", async () => {
  const root = await workspace();
  await makeTask(root, "ocean", "T-2");
  await writeManifest(root, "ocean", { nextTask: 7 });
  assert.equal(await peekNextTaskId("ocean"), "T-007");
});

test("withNextTaskId advances the counter only when the write succeeded", async () => {
  const root = await workspace();
  await writeManifest(root, "app", { prefix: "AP", nextTask: 1 });
  const refused = await withNextTaskId("app", async () => ({ ok: false }));
  assert.equal(refused.ok, false);
  assert.equal(await peekNextTaskId("app"), "AP-001");
  const done = await withNextTaskId("app", async (id) => {
    await makeTask(root, "app", id);
    return { ok: true, id };
  });
  assert.equal(done.id, "AP-001");
  const manifest = JSON.parse(
    await readFile(
      path.join(root, PROJECTS_DIR, "app", "project.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.nextTask, 2);
  assert.equal(manifest.prefix, "AP");
});

test("two concurrent creators get distinct ids", async () => {
  const root = await workspace();
  await writeManifest(root, "app", { prefix: "AP", nextTask: 1 });
  const create = () =>
    withNextTaskId("app", async (id) => {
      await makeTask(root, "app", id);
      return { ok: true, id };
    });
  const [a, b, c] = await Promise.all([create(), create(), create()]);
  assert.deepEqual([a.id, b.id, c.id].sort(), ["AP-001", "AP-002", "AP-003"]);
});

test("without a manifest the scan decides and nothing is written", async () => {
  const root = await workspace();
  await makeTask(root, "ocean", "T-5");
  const result = await withNextTaskId("ocean", async (id) => ({
    ok: true,
    id,
  }));
  assert.equal(result.id, "T-006");
  assert.deepEqual(await listProjectManifests(), []);
});

test("a prefix is scanned within its own namespace only", async () => {
  const root = await workspace();
  await writeManifest(root, "app", { prefix: "AP", nextTask: 1 });
  await makeTask(root, "app", "T-90");
  await makeTask(root, "app", "AP-004");
  assert.equal(await peekNextTaskId("app"), "AP-005");
});

test("bindProject gives a new empty project a derived prefix and keeps both on --add", async () => {
  await workspace();
  const repo = await mkdtemp(path.join(os.tmpdir(), "ocean-numbering-repo-"));
  const second = await mkdtemp(path.join(os.tmpdir(), "ocean-numbering-repo-"));
  await bindProject("ocean-language", repo);
  let [manifest] = await listProjectManifests();
  assert.equal(manifest.prefix, "OL");
  assert.equal(manifest.nextTask, 1);
  await withNextTaskId("ocean-language", async () => ({ ok: true }));
  await bindProject("ocean-language", second, { addPath: true });
  [manifest] = await listProjectManifests();
  assert.equal(manifest.prefix, "OL");
  assert.equal(manifest.nextTask, 2);
  assert.equal(manifest.paths.length, 2);
  assert.deepEqual(await knownTaskPrefixes(), ["T", "OL"]);
  assert.equal(await projectForPrefix("OL"), "ocean-language");
  assert.equal(await projectForPrefix("T"), null);
});

test("a project that already holds tasks stays on T when first bound", async () => {
  const root = await workspace();
  const repo = await mkdtemp(path.join(os.tmpdir(), "ocean-numbering-repo-"));
  await makeTask(root, "legacy", "T-12");
  await bindProject("legacy", repo);
  const [manifest] = await listProjectManifests();
  assert.equal(manifest.prefix, undefined);
  assert.equal(manifest.nextTask, undefined);
});

test("two projects never share a derived prefix", async () => {
  await workspace();
  const a = await mkdtemp(path.join(os.tmpdir(), "ocean-numbering-repo-"));
  const b = await mkdtemp(path.join(os.tmpdir(), "ocean-numbering-repo-"));
  await bindProject("ocean-lab", a);
  await bindProject("open-lab", b);
  const prefixes = (await listProjectManifests()).map((m) => m.prefix).sort();
  assert.deepEqual(prefixes, ["OL", "OL2"]);
});

test("a manifest with an invalid prefix or counter is reported, not trusted", async () => {
  const root = await workspace();
  await writeManifest(root, "bad", { prefix: "utf" });
  await writeManifest(root, "worse", { prefix: "AB", nextTask: 0 });
  await writeManifest(root, "good", { prefix: "GD", nextTask: 1 });
  const { scanProjectManifests } = await import(
    "@ocean/core/shared/project-resolution.js"
  );
  const scan = await scanProjectManifests();
  assert.deepEqual(
    scan.manifests.map((m) => m.id),
    ["good"],
  );
  assert.equal(scan.errors.length, 2);
});

test("two manifests claiming one prefix is an error, not a guess", async () => {
  const root = await workspace();
  await writeManifest(root, "one", { prefix: "XX" });
  await writeManifest(root, "two", { prefix: "XX" });
  await assert.rejects(projectForPrefix("XX"), /claimed by one, two/);
});
