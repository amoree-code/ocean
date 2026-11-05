import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reindexBrain } from "@ocean/brain/brain/brain-reindex.js";
import {
  queryTokens,
  selectActiveLessons,
} from "@ocean/brain/memory/lesson-activation.js";
import {
  addLesson,
  confirmLesson,
  setLessonStatus,
} from "@ocean/brain/memory/lessons.js";
import {
  detectSessionSignals,
  hasUserCorrection,
} from "@ocean/market/skills/signal-detection.js";
import { defaultBrainIndexPort } from "../dist/composition/runtime.js";

const previousRoot = process.env.OCEAN_ROOT;
const roots = [];
test.after(async () => {
  if (previousRoot === undefined) delete process.env.OCEAN_ROOT;
  else process.env.OCEAN_ROOT = previousRoot;
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});

async function freshRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-activation-"));
  roots.push(root);
  process.env.OCEAN_ROOT = root;
  return root;
}
const reindex = () => reindexBrain({ indexPort: defaultBrainIndexPort });
const select = (prompt, extra = {}) =>
  selectActiveLessons(prompt, {
    maxBytes: 4096,
    indexPort: defaultBrainIndexPort,
    ...extra,
  });
const active = async (id, body, title = id) => {
  await addLesson({ id, title, body, confidence: 0.8 });
  await setLessonStatus(id, "active");
};

test("an active lesson is found by meaning-bearing words, not by its name", async () => {
  await freshRoot();
  await active(
    "lesson-pnpm",
    "Always run pnpm install with the frozen lockfile before building the workspace.",
    "Package manager habit",
  );
  await active(
    "lesson-other",
    "Prefer small commits with conventional messages.",
  );
  await reindex();
  const found = await select(
    "please build the workspace, the lockfile install keeps failing",
  );
  assert.deepEqual(
    found.map((lesson) => lesson.id),
    ["lesson-pnpm"],
  );
  assert.deepEqual(await select("completely unrelated gardening question"), []);
});

test("candidates and retired lessons never activate, even when indexed", async () => {
  await freshRoot();
  await addLesson({
    id: "lesson-candidate",
    title: "t",
    body: "Always verify the frozen lockfile during workspace builds.",
  });
  await active(
    "lesson-retired",
    "Always verify the frozen lockfile during workspace builds.",
  );
  await reindex();
  await setLessonStatus("lesson-retired", "retired");
  assert.deepEqual(
    await select("verify the frozen lockfile in workspace builds"),
    [],
  );
});

test("a lesson that decayed below the floor stops activating", async () => {
  await freshRoot();
  await active(
    "lesson-old",
    "Always verify the frozen lockfile during workspace builds.",
  );
  await reindex();
  const prompt = "verify the frozen lockfile in workspace builds";
  assert.equal((await select(prompt)).length, 1);
  const later = new Date(Date.now() + 90 * 86_400_000);
  assert.deepEqual(await select(prompt, { now: later }), []);
  await confirmLesson("lesson-old", { now: later });
  assert.equal((await select(prompt, { now: later })).length, 1);
});

test("with no index built nothing activates", async () => {
  await freshRoot();
  await active(
    "lesson-x",
    "Always verify the frozen lockfile during workspace builds.",
  );
  assert.deepEqual(
    await select("verify the frozen lockfile in workspace builds"),
    [],
  );
});

test("an over-budget lesson is cut on a character boundary with a pointer", async () => {
  await freshRoot();
  await active(
    "lesson-arabic",
    `check lockfile handling مرحبا بالعالم ${"مرحبا بالعالم ".repeat(400)}`,
  );
  await reindex();
  const [lesson] = await select("check the lockfile handling", {
    maxBytes: 1000,
  });
  assert.equal(lesson.truncated, true);
  assert.ok(Buffer.byteLength(lesson.body) <= 1000);
  assert.match(lesson.body, /`ocean skill list lesson-arabic`/);
  assert.ok(!lesson.body.includes("�"));
  const [whole] = await select("check the lockfile handling", {
    maxBytes: 32_000,
  });
  assert.equal(whole.truncated, false);
});

test("query tokens keep short technical terms, drop filler, and prefer longer ones", () => {
  assert.deepEqual(
    queryTokens("Fix the git rebase bug in T-230 with the lockfile").slice(
      0,
      4,
    ),
    ["lockfile", "rebase", "t-230", "bug"],
  );
});

const event = (type, data, eventId = 1) => ({ type, data, eventId });

test("only a real user correction counts, not provider output using those words", () => {
  const provider = [
    event(
      "provider_output",
      "Actually, that's wrong, you should use pnpm instead of npm",
    ),
  ];
  assert.equal(hasUserCorrection(provider), false);
  const user = [event("user_input", "no, please use pnpm in this repository")];
  assert.equal(hasUserCorrection(user), true);
});

test("signals need proven evidence and surface repeated procedures and decisions", () => {
  const output = (text, id) => event("provider_output", text, id);
  const proven = event("evidence", JSON.stringify({ result: "proven" }), 9);
  assert.deepEqual(
    detectSessionSignals([output("Decision: ship it on Friday", 1)]),
    [],
  );
  const signals = detectSessionSignals([
    output("Decision: ship it on Friday", 1),
    output("Run the full build before committing", 2),
    output("Run the full build before committing", 3),
    proven,
  ]);
  assert.deepEqual(signals.map((signal) => signal.signalType).sort(), [
    "explicit-decision",
    "repeated-procedure",
  ]);
});
