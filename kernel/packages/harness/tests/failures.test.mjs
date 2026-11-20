import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addLesson, readLesson } from "@ocean/brain/memory/lessons.js";
import {
  climbFailure,
  failureRecurrence,
  failuresDir,
  ladderFindings,
  listFailures,
  openFailure,
  setFailureStatus,
} from "@ocean/services/journey/failures.js";
import {
  lessonEffects,
  MIN_SAMPLE,
  retirementFindings,
} from "@ocean/services/journey/lesson-effect.js";
import {
  errorClass,
  failureSignature,
  signatureStats,
} from "@ocean/services/journey/telemetry.js";
import { failuresRows } from "@ocean/services/scorecard/scorecard.js";

// T-323: failure signatures, failure records with a closed status, the guardrail ladder, and
// whether a lesson helps.

const previousRoot = process.env.OCEAN_ROOT;
const roots = [];
test.after(async () => {
  if (previousRoot === undefined) delete process.env.OCEAN_ROOT;
  else process.env.OCEAN_ROOT = previousRoot;
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});

async function freshRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-failures-"));
  roots.push(root);
  process.env.OCEAN_ROOT = root;
  return root;
}

const ZOD = (n) =>
  `[{"origin":"string","code":"too_small","minimum":${n},"path":["title"]}]`;
const SIG = failureSignature("closeout_warning", ZOD(1));

test("a signature is command / error class / hash, stable across ids, paths and numbers", () => {
  assert.match(SIG, /^closeout\/too_small\/[0-9a-f]{8}$/);
  assert.equal(failureSignature("closeout_warning", ZOD(7)), SIG);
  assert.equal(
    failureSignature("error", "spawn codex ENOENT /a/1"),
    failureSignature("error", "spawn codex ENOENT /b/22"),
  );
  assert.match(
    failureSignature("error", "spawn x ENOENT /a"),
    /^run\/ENOENT\//,
  );
  assert.equal(errorClass("TypeError: x is not a function"), "TypeError");
  assert.equal(errorClass("something broke"), "error");
  // Not a failure event, or nothing to say: no signature.
  assert.equal(failureSignature("text", "ENOENT"), null);
  assert.equal(failureSignature("error", "   "), null);
});

test("a failure record states its mechanism, keeps one record per signature, and moves only through the closed vocabulary", async () => {
  await freshRoot();
  await assert.rejects(
    openFailure({ id: "f", title: "t", signature: SIG, mechanism: " " }),
    /mechanism/,
  );
  await assert.rejects(
    openFailure({ id: "f", title: "t", signature: "bad", mechanism: "m" }),
    /signature/,
  );
  const opened = await openFailure({
    id: "empty-title",
    title: "Handoff rejected an empty session title",
    signature: SIG,
    mechanism: "`??` keeps an empty string, so the schema saw title ''",
  });
  assert.equal(opened.status, "open");
  assert.equal(opened.rung, "lesson");
  await assert.rejects(
    openFailure({ id: "again", title: "t", signature: SIG, mechanism: "m" }),
    /already has a record: empty-title/,
  );
  // Absorbing names the mechanism, from the closed cheapest-first list.
  await assert.rejects(setFailureStatus("empty-title", "absorbed"), /--by/);
  await assert.rejects(
    setFailureStatus("empty-title", "absorbed", { by: "vibes" }),
    /--by/,
  );
  await setFailureStatus("empty-title", "fix-landing");
  const absorbed = await setFailureStatus("empty-title", "absorbed", {
    by: "code",
  });
  assert.equal(absorbed.absorbedBy, "code");
  assert.ok(absorbed.absorbedAt);
  // Absorbed goes back to open only by climbing.
  await assert.rejects(
    setFailureStatus("empty-title", "open"),
    /not allowed.*climb/,
  );
  const file = path.join(failuresDir(), "empty-title.md");
  const before = await readFile(file, "utf8");
  const climbed = await climbFailure("empty-title");
  assert.equal(climbed.rung, "doctor");
  assert.equal(climbed.status, "open");
  assert.equal(climbed.absorbedAt, null);
  const after = await readFile(file, "utf8");
  // Past entries are never rewritten: the old body is still there, one log line is added.
  const body = (text) => text.slice(text.indexOf("\n---", 3));
  assert.ok(body(after).startsWith(body(before).trimEnd()));
  assert.equal(
    body(after).trimEnd().split("\n").length,
    body(before).trimEnd().split("\n").length + 1,
  );
  assert.match(after, /## Mechanism\n\n`\?\?` keeps an empty string/);
  await climbFailure("empty-title");
  await assert.rejects(climbFailure("empty-title"), /top rung/);
  await setFailureStatus("empty-title", "superseded-by newer");
  await assert.rejects(
    setFailureStatus("empty-title", "fix-landing"),
    /superseded by newer/,
  );
  assert.deepEqual(
    (await listFailures()).map((r) => [r.status, r.supersededBy]),
    [["superseded", "newer"]],
  );
});

test("absorbing a failure retires its lesson, so it leaves context", async () => {
  await freshRoot();
  await addLesson({
    id: "check-title",
    title: "t",
    body: "b",
    status: "active",
  });
  await openFailure({
    id: "f1",
    title: "t",
    signature: SIG,
    mechanism: "m",
    lesson: "check-title",
  });
  await setFailureStatus("f1", "absorbed", { by: "code" });
  assert.equal((await readLesson("check-title")).status, "retired");
});

const session = (id, createdAt, status = "completed") => ({
  sessionId: id,
  provider: "claude",
  status,
  createdAt,
});

test("recurrence is counted per signature; an absorbed failure that comes back proposes one rung up", () => {
  const record = (absorbedAt, rung = "lesson") => ({
    id: "f1",
    signature: SIG,
    status: "absorbed",
    rung,
    absorbedAt,
  });
  const sessions = ["2026-11-01", "2026-11-02", "2026-11-10"].map((day, n) =>
    session(`s${n}`, `${day}T00:00:00.000Z`),
  );
  const events = (id) => [
    {
      type: "closeout_warning",
      data: ZOD(1),
      createdAt: sessions.find((s) => s.sessionId === id).createdAt,
    },
  ];
  const stats = signatureStats(sessions, events, "");
  const now = new Date("2026-11-21T00:00:00.000Z");
  // Absorbed after the last sighting: clean, no proposal.
  const [clean] = failureRecurrence(
    [record("2026-11-11T00:00:00.000Z")],
    stats,
    now,
  );
  assert.equal(clean.sinceAbsorbed, 0);
  assert.equal(clean.recent, 1);
  assert.equal(clean.cleanDays, 10);
  assert.deepEqual(ladderFindings([clean]), []);
  // Seen in two sessions after it was absorbed: climb lesson → doctor.
  const [back] = failureRecurrence(
    [record("2026-11-01T12:00:00.000Z")],
    stats,
    now,
  );
  assert.equal(back.sinceAbsorbed, 2);
  const [finding] = ladderFindings([back]);
  assert.match(finding.line, /lesson → doctor.*ocean failures climb f1/);
  // On the top rung the proposal is a new record instead.
  const [top] = failureRecurrence(
    [record("2026-11-01T12:00:00.000Z", "test")],
    stats,
    now,
  );
  assert.match(ladderFindings([top])[0].line, /top rung.*supersede/);
  // The scorecard: zero only when absorbed, unseen in the window and clean long enough.
  const later = new Date("2026-11-30T00:00:00.000Z");
  const [zeroed] = failureRecurrence(
    [record("2026-11-11T00:00:00.000Z")],
    stats,
    later,
  );
  const [summary, row] = failuresRows([zeroed]);
  assert.equal(summary.value, "1 of 1");
  assert.match(
    row.value,
    /absorbed, rung lesson: 0 sessions in 14 d, clean 19 d/,
  );
  assert.equal(failuresRows([clean])[0].value, "0 of 1");
});

test("a lesson is compared with comparable sessions that ran without it; no better means proposed retirement", () => {
  const sessions = [];
  const events = {};
  const add = (id, applied, verified) => {
    sessions.push(session(id, "2026-11-10T00:00:00.000Z"));
    events[id] = [
      { type: "context_manifest", data: "{}" },
      ...(applied
        ? [{ type: "lesson_applied", data: JSON.stringify({ id: "l1" }) }]
        : []),
      ...(verified
        ? [
            {
              type: "evidence",
              data: JSON.stringify({ type: "test", result: "proven" }),
            },
          ]
        : []),
    ];
  };
  for (let n = 0; n < MIN_SAMPLE; n++) {
    add(`w${n}`, true, n < 2);
    add(`o${n}`, false, n < 3);
  }
  // Not comparable: never assembled context, so a lesson could not have been injected.
  sessions.push(session("chat", "2026-11-10T00:00:00.000Z"));
  events.chat = [];
  const eventsOf = (id) => events[id] ?? [];
  const [effect] = lessonEffects(sessions, eventsOf, "2026-11-01");
  assert.deepEqual(
    [effect.with.sessions, effect.with.verified, effect.without.verified],
    [MIN_SAMPLE, 2, 3],
  );
  assert.equal(effect.verdict, "no-better");
  assert.match(
    retirementFindings([effect])[0].line,
    /ocean skill review l1 rejected/,
  );
  // Fewer sessions than the sample on one side: no verdict either way.
  const [few] = lessonEffects(
    sessions.filter((s) => !s.sessionId.startsWith("o")),
    eventsOf,
    "2026-11-01",
  );
  assert.equal(few.verdict, "too-few");
  assert.deepEqual(retirementFindings([few]), []);
});
