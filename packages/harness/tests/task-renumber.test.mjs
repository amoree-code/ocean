import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PROJECTS_DIR } from "../dist/paths.js";

// ocean has T-1 and T-2; lab holds T-5, T-7 live and T-6 archived.
async function fixture({ oceanManifest = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-renumber-"));
  const task = async (project, parts, extra = "") => {
    const dir = path.join(root, PROJECTS_DIR, project, "tasks", ...parts);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "task.md"),
      `---\nid: ${parts.at(-1)}\n${extra}title: ${parts.at(-1)}\nstate: active\nproject: ${project}\n---\n\nBody mentions id: and T-5.\n`,
    );
  };
  await task("ocean", ["T-1"]);
  await task("ocean", ["T-2"]);
  await task("lab", ["T-7"]);
  await task("lab", ["T-5"]);
  await task("lab", ["archive", "lab", "T-6"]);
  const manifest = async (project, extra = {}) => {
    await mkdir(path.join(root, PROJECTS_DIR, project), { recursive: true });
    await writeFile(
      path.join(root, PROJECTS_DIR, project, "project.json"),
      JSON.stringify({ name: project, paths: [], ...extra }),
    );
  };
  if (oceanManifest) await manifest("ocean");
  await manifest("lab");
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [path.resolve("dist/main.js"), "tasks", "renumber", ...args],
      {
        cwd: root,
        env: { ...process.env, OCEAN_ROOT: root },
        encoding: "utf8",
      },
    );
  const json = async (project, file) =>
    JSON.parse(
      await readFile(path.join(root, PROJECTS_DIR, project, file), "utf8"),
    );
  const names = (project, ...parts) =>
    readdir(path.join(root, PROJECTS_DIR, project, "tasks", ...parts)).then(
      (n) => n.sort(),
    );
  return { root, run, json, names, manifest };
}

test("a dry run reports the mapping and writes nothing", async () => {
  const { run, json, names } = await fixture();
  const result = run("--project", "lab", "--prefix", "LB");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    dryRun: true,
    project: "lab",
    prefix: "LB",
    moves: [
      { from: "T-5", to: "LB-001", archived: false },
      { from: "T-7", to: "LB-003", archived: false },
      { from: "T-6", to: "LB-002", archived: true },
    ].sort((a, b) => a.to.localeCompare(b.to)),
    nextTask: 4,
  });
  assert.deepEqual(await names("lab"), ["T-5", "T-7", "archive"]);
  assert.deepEqual(await json("lab", "project.json"), {
    name: "lab",
    paths: [],
  });
});

test("--write renames live and archived tasks, keeps legacyId, and sets both counters", async () => {
  const { root, run, json, names } = await fixture();
  const result = run("--project", "lab", "--prefix", "LB", "--write");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).dryRun, false);
  assert.deepEqual(await names("lab"), ["LB-001", "LB-003", "archive"]);
  assert.deepEqual(await names("lab", "archive", "lab"), ["LB-002"]);
  const record = await readFile(
    path.join(root, PROJECTS_DIR, "lab", "tasks", "LB-003", "task.md"),
    "utf8",
  );
  assert.match(record, /^---\nid: LB-003\nlegacyId: T-7\ntitle: T-7\n/);
  assert.match(record, /Body mentions id: and T-5\./, "bodies are untouched");
  const lab = await json("lab", "project.json");
  assert.equal(lab.prefix, "LB");
  assert.equal(lab.nextTask, 4);
  // T-7 was the highest T number anywhere: ocean must not reissue 1..7.
  assert.equal((await json("ocean", "project.json")).nextTask, 8);
});

test("a rerun changes nothing, and picks up only what is new", async () => {
  const { root, run, json, names } = await fixture();
  run("--project", "lab", "--prefix", "LB", "--write");
  const again = JSON.parse(
    run("--project", "lab", "--prefix", "LB", "--write").stdout,
  );
  assert.deepEqual(again.moves, []);
  assert.equal(again.nextTask, 4);
  await mkdir(path.join(root, PROJECTS_DIR, "lab", "tasks", "T-9"));
  await writeFile(
    path.join(root, PROJECTS_DIR, "lab", "tasks", "T-9", "task.md"),
    "---\nid: T-9\ntitle: late\nstate: active\nproject: lab\n---\n",
  );
  const third = JSON.parse(
    run("--project", "lab", "--prefix", "LB", "--write").stdout,
  );
  assert.deepEqual(third.moves, [
    { from: "T-9", to: "LB-004", archived: false },
  ]);
  assert.deepEqual(await names("lab"), [
    "LB-001",
    "LB-003",
    "LB-004",
    "archive",
  ]);
  assert.equal((await json("lab", "project.json")).nextTask, 5);
});

test("it refuses the workspace project, a taken or reserved prefix, and bad shapes", async () => {
  const { run, manifest } = await fixture();
  await manifest("other", { prefix: "OT", nextTask: 1 });
  const cases = [
    [["--project", "ocean", "--prefix", "OC"], /workspace project/],
    [["--project", "lab", "--prefix", "OT"], /already used by other/],
    [["--project", "lab", "--prefix", "UTF"], /not a usable prefix/],
    [["--project", "lab", "--prefix", "lb"], /not a usable prefix/],
    [["--project", "lab", "--prefix", "T"], /not a usable prefix/],
    [["--project", "nope", "--prefix", "NP"], /no project.json for 'nope'/],
    [["--prefix", "LB"], /Usage/],
  ];
  for (const [args, pattern] of cases) {
    const result = run(...args, "--write");
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr, pattern, args.join(" "));
  }
});

test("it refuses without the workspace manifest and tells how to get one", async () => {
  const { run } = await fixture({ oceanManifest: false });
  const result = run("--project", "lab", "--prefix", "LB", "--write");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ocean project migrate --write/);
});

test("it refuses when a target folder already exists, before changing anything", async () => {
  const { root, run, names } = await fixture();
  await mkdir(path.join(root, PROJECTS_DIR, "lab", "tasks", "LB-001"));
  const result = run("--project", "lab", "--prefix", "LB", "--write");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already exists/);
  assert.deepEqual(await names("lab"), ["LB-001", "T-5", "T-7", "archive"]);
});

test("after a renumber, a third project still on T never reissues a moved number", async () => {
  const { root, run, manifest } = await fixture();
  await manifest("shop");
  await mkdir(path.join(root, PROJECTS_DIR, "shop", "tasks", "T-3"), {
    recursive: true,
  });
  assert.equal(run("--project", "lab", "--prefix", "LB", "--write").status, 0);
  // T-7 now lives on only as LB-003's legacyId; the folder scan no longer sees it.
  const peek = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(path.resolve("dist/application/context/project-resolution.js"))}); console.log(await m.peekNextTaskId("shop"));`,
    ],
    { env: { ...process.env, OCEAN_ROOT: root }, encoding: "utf8" },
  );
  assert.equal(peek.stdout.trim(), "T-008", peek.stderr);
});

test("a record without an id in its frontmatter refuses the run before any write", async () => {
  const { root, run, json, names } = await fixture();
  await writeFile(
    path.join(root, PROJECTS_DIR, "lab", "tasks", "T-5", "task.md"),
    "---\ntitle: no id\n---\n\nid: T-5 in the body\n",
  );
  const result = run("--project", "lab", "--prefix", "LB", "--write");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /has no id in its frontmatter/);
  assert.deepEqual(await names("lab"), ["T-5", "T-7", "archive"]);
  assert.equal((await json("lab", "project.json")).prefix, undefined);
  assert.equal((await json("ocean", "project.json")).nextTask, undefined);
});
