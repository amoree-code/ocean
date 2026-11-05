import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addLesson,
  confirmLesson,
  contradictLesson,
  effectiveConfidence,
  lessonsDir,
  listLessons,
  migrateLegacyLessons,
  readLesson,
} from "@ocean/brain/memory/lessons.js";
import { SYSTEM_DIR } from "@ocean/core/shared/paths.js";

const T0 = new Date("2026-10-01T00:00:00.000Z");
const days = (n) => new Date(T0.getTime() + n * 86_400_000);

const previousRoot = process.env.OCEAN_ROOT;
const roots = [];
async function freshRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-lessons-"));
  roots.push(root);
  process.env.OCEAN_ROOT = root;
  return root;
}
test.after(async () => {
  if (previousRoot === undefined) delete process.env.OCEAN_ROOT;
  else process.env.OCEAN_ROOT = previousRoot;
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("a lesson round-trips through its markdown record", async () => {
  await freshRoot();
  await addLesson(
    {
      id: "use-pnpm",
      title: 'Use "pnpm" here',
      body: "Run pnpm, never npm.",
      confidence: 0.8,
      evidence: ["event:1"],
      sourceSessionId: "s1",
    },
    T0,
  );
  const lesson = await readLesson("use-pnpm");
  assert.equal(lesson.title, 'Use "pnpm" here');
  assert.equal(lesson.body, "Run pnpm, never npm.");
  assert.equal(lesson.status, "candidate");
  assert.equal(lesson.confidence, 0.8);
  assert.deepEqual(lesson.evidence, ["event:1"]);
  assert.equal(lesson.sourceSessionId, "s1");
  const raw = await readFile(path.join(lessonsDir(), "use-pnpm.md"), "utf8");
  assert.match(raw, /^type: experiential$/m);
  assert.equal((await listLessons()).length, 1);
});

test("rejects duplicates, bad ids and secrets", async () => {
  await freshRoot();
  const ok = { id: "a-lesson", title: "t", body: "b" };
  await addLesson(ok, T0);
  await assert.rejects(addLesson(ok, T0), /Duplicate/);
  await assert.rejects(addLesson({ ...ok, id: "../escape" }, T0), /Invalid/);
  await assert.rejects(
    addLesson({ ...ok, id: "x", body: "api_key: abc" }, T0),
    /sensitive/,
  );
});

test("confidence halves every 30 days without confirmation", async () => {
  await freshRoot();
  const lesson = await addLesson(
    { id: "decay", title: "t", body: "b", confidence: 0.8 },
    T0,
  );
  assert.equal(effectiveConfidence(lesson, T0), 0.8);
  assert.ok(Math.abs(effectiveConfidence(lesson, days(30)) - 0.4) < 1e-9);
  assert.ok(Math.abs(effectiveConfidence(lesson, days(60)) - 0.2) < 1e-9);
});

test("confirming a lesson counts a hit and restarts the decay clock", async () => {
  await freshRoot();
  await addLesson({ id: "c", title: "t", body: "b", confidence: 0.8 }, T0);
  const confirmed = await confirmLesson("c", {
    evidence: "session:s2",
    now: days(30),
  });
  assert.equal(confirmed.hits, 1);
  assert.ok(Math.abs(confirmed.confidence - 0.5) < 1e-9); // 0.4 decayed + 0.1
  assert.equal(confirmed.lastConfirmedAt, days(30).toISOString());
  assert.ok(Math.abs(effectiveConfidence(confirmed, days(30)) - 0.5) < 1e-9);
  const again = await confirmLesson("c", {
    evidence: "session:s2",
    now: days(30),
  });
  assert.deepEqual(again.evidence, ["session:s2"]);
  assert.equal(again.hits, 2);
});

test("a contradicted lesson loses confidence, is logged, and retires when low", async () => {
  await freshRoot();
  await addLesson({ id: "k", title: "t", body: "b", confidence: 0.8 }, T0);
  const first = await contradictLesson("k", {
    reason: "user said no",
    now: T0,
  });
  assert.ok(Math.abs(first.confidence - 0.4) < 1e-9);
  assert.equal(first.status, "candidate");
  const log = await readFile(path.join(lessonsDir(), "CONFLICTS.md"), "utf8");
  assert.match(log, /`k` contradicted: user said no/);
  let last = first;
  for (let i = 0; i < 3; i++)
    last = await contradictLesson("k", { reason: "again", now: T0 });
  assert.equal(last.status, "retired");
  assert.equal((await readLesson("k")).status, "retired");
});

test("migrates both legacy stores once, keeps them as *.migrated, leaves command logs", async () => {
  const root = await freshRoot();
  const skills = path.join(root, SYSTEM_DIR, "skills");
  await mkdir(skills, { recursive: true });
  await writeFile(
    path.join(skills, "candidates.json"),
    JSON.stringify([
      {
        id: "p1",
        name: "Promoted one",
        instructions: "do x",
        status: "promoted",
        verification: "owner-reviewed",
      },
      { id: "r1", name: "Rejected", instructions: "do y", status: "rejected" },
    ]),
  );
  await writeFile(
    path.join(skills, "observations.json"),
    JSON.stringify([
      {
        observationId: "obs-aaa",
        summary: "seen twice",
        confidence: 0.7,
        status: "observed",
        evidenceRefs: ["event:9"],
      },
      {
        observationId: "obs-bbb",
        summary: "tossed",
        status: "discarded",
      },
      {
        observationId: "obs-ccc",
        summary: "became p1",
        status: "approved",
        skillCandidateId: "p1",
      },
    ]),
  );
  const commandLogs = path.join(root, SYSTEM_DIR, "observations");
  await mkdir(commandLogs, { recursive: true });
  await writeFile(path.join(commandLogs, "x.json"), "{}");

  assert.deepEqual(await migrateLegacyLessons(T0), { migrated: 4, skipped: 1 });
  const byId = Object.fromEntries((await listLessons()).map((l) => [l.id, l]));
  assert.equal(byId["lesson-p1"].status, "active");
  assert.equal(byId["lesson-r1"].status, "retired");
  assert.equal(byId["lesson-obs-aaa"].status, "candidate");
  assert.equal(byId["lesson-obs-bbb"].status, "retired");
  await readFile(path.join(skills, "candidates.json.migrated"), "utf8");
  await readFile(path.join(skills, "observations.json.migrated"), "utf8");
  await readFile(path.join(commandLogs, "x.json"), "utf8");

  assert.deepEqual(await migrateLegacyLessons(T0), { migrated: 0, skipped: 0 });
});

test("secrets are refused in evidence and in contradiction reasons", async () => {
  await freshRoot();
  await addLesson({ id: "s", title: "t", body: "b" }, T0);
  await assert.rejects(
    addLesson({ id: "s2", title: "t", body: "b", evidence: ["token: x"] }, T0),
    /sensitive/,
  );
  await assert.rejects(
    confirmLesson("s", { evidence: "password=x" }),
    /sensitive/,
  );
  await assert.rejects(
    contradictLesson("s", { reason: "secret: x" }),
    /sensitive/,
  );
  assert.equal((await readLesson("s")).hits, 0);
});

test("a CRLF lesson file keeps its body clean", async () => {
  await freshRoot();
  await addLesson({ id: "crlf", title: "t", body: "line one\nline two" }, T0);
  const file = path.join(lessonsDir(), "crlf.md");
  await writeFile(file, (await readFile(file, "utf8")).replace(/\n/g, "\r\n"));
  assert.equal((await readLesson("crlf")).body, "line one\nline two");
});

test("migration aborts untouched on a corrupt store and never collides ids", async () => {
  const root = await freshRoot();
  const skills = path.join(root, SYSTEM_DIR, "skills");
  await mkdir(skills, { recursive: true });
  await writeFile(
    path.join(skills, "candidates.json"),
    JSON.stringify([
      { id: "Foo_1", name: "a", instructions: "one" },
      { id: "foo-1", name: "b", instructions: "two" },
    ]),
  );
  await writeFile(path.join(skills, "observations.json"), "{not json");
  await assert.rejects(migrateLegacyLessons(T0));
  assert.equal((await listLessons()).length, 0);
  await readFile(path.join(skills, "candidates.json"), "utf8");

  await writeFile(path.join(skills, "observations.json"), "[]");
  assert.deepEqual(await migrateLegacyLessons(T0), { migrated: 2, skipped: 0 });
});
