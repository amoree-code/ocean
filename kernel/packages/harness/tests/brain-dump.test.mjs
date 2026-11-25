import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  withoutWrappers,
  writeBrainDump,
  writeDigestRecord,
} from "@ocean/brain/memory/brain-dump.js";
import { localDate, localTime } from "@ocean/core/shared/local-date.js";

// The session's start on the machine's clock (T-297), as the file name stamps it.
const started = new Date("2026-09-21T15:52:00.000Z");
const stamp = `${localDate(started)}-${localTime(started).replace(":", "")}`;

function baseSession(overrides = {}) {
  return {
    sessionId: "11112222-3333-4444-5555-666677778888",
    title: "claude session",
    ticketId: null,
    handoffId: null,
    provider: "claude",
    providerSessionId: null,
    parentSessionId: null,
    profile: "desktop:claude",
    profileIdentity: "",
    workingDirectory: "/tmp/does-not-matter",
    status: "completed",
    createdAt: "2026-09-21T15:52:00.000Z",
    updatedAt: "2026-09-21T15:52:00.000Z",
    resumeData: null,
    contextHash: null,
    contextBytes: 0,
    nextAction: "Review the summary and verify the next action.",
    verificationStatus: "unknown",
    summaryPath: null,
    summaryHash: null,
    summaryBytes: 0,
    closeoutStatus: "pending",
    closeoutVersion: "1",
    closedAt: null,
    ...overrides,
  };
}

test("names the file from the date, time, and a slug of the work log — not the raw session id", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-brain-dump-"));
  process.env.OCEAN_ROOT = root;

  const result = await writeBrainDump({
    session: baseSession(),
    events: [],
    changedFiles: [],
    narrative: { workLog: "Wire the brain-dump hook for Desktop sessions" },
  });

  assert.ok(result);
  const filename = path.basename(result.brainDumpPath);
  assert.equal(
    filename,
    `${stamp}-wire-the-brain-dump-hook-for-desktop-sessions.md`,
  );
  assert.doesNotMatch(filename, /11112222-3333-4444-5555-666677778888/);

  delete process.env.OCEAN_ROOT;
});

test("falls back to the project name, then the short session id, when the title has no usable Latin slug", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-brain-dump-"));
  process.env.OCEAN_ROOT = root;

  // The project is the store session's (T-331), never the folder's name.
  const withProject = await writeBrainDump({
    session: baseSession({
      workingDirectory: "/opt/projects/elsewhere",
      projectId: "ameer",
    }),
    events: [],
    changedFiles: [],
    narrative: { workLog: "شنو صار اليوم" },
  });
  assert.ok(withProject);
  assert.equal(path.basename(withProject.brainDumpPath), `${stamp}-ameer.md`);

  const noProject = await writeBrainDump({
    session: baseSession({
      sessionId: "abcdef12-0000-0000-0000-000000000000",
      workingDirectory: "/",
    }),
    events: [],
    changedFiles: [],
    narrative: { workLog: "شنو صار اليوم" },
  });
  assert.ok(noProject);
  assert.equal(path.basename(noProject.brainDumpPath), `${stamp}-abcdef12.md`);

  delete process.env.OCEAN_ROOT;
});

test("appends a numeric suffix instead of overwriting when two sessions land on the same slug", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-brain-dump-"));
  process.env.OCEAN_ROOT = root;

  const first = await writeBrainDump({
    session: baseSession({ sessionId: "session-one" }),
    events: [],
    changedFiles: [],
    narrative: { workLog: "Fix the login bug" },
  });
  const second = await writeBrainDump({
    session: baseSession({ sessionId: "session-two" }),
    events: [],
    changedFiles: [],
    narrative: { workLog: "Fix the login bug" },
  });

  assert.notEqual(first.brainDumpPath, second.brainDumpPath);
  assert.equal(
    path.basename(first.brainDumpPath),
    `${stamp}-fix-the-login-bug.md`,
  );
  assert.equal(
    path.basename(second.brainDumpPath),
    `${stamp}-fix-the-login-bug-2.md`,
  );

  const files = await readdir(
    path.join(root, path.dirname(first.brainDumpPath)),
  );
  assert.equal(files.length, 2);

  delete process.env.OCEAN_ROOT;
});

test("mirrors task-observer signals under a Signals section when present, and omits it otherwise", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-brain-dump-"));
  process.env.OCEAN_ROOT = root;

  const withSignals = await writeBrainDump({
    session: baseSession({ sessionId: "session-signals" }),
    events: [],
    changedFiles: [],
    narrative: { workLog: "Fix the flaky retry logic" },
    observations: [
      {
        observationId: "obs-1",
        sourceSessionId: "session-signals",
        taskId: null,
        profileId: "reviewer",
        signalType: "repeated-correction",
        summary: "Don't mock the database in integration tests",
        evidenceRefs: [],
        confidence: 0.8,
        status: "observed",
        createdAt: "2026-09-21T15:52:00.000Z",
        reviewedAt: null,
        skillCandidateId: null,
      },
    ],
  });
  assert.ok(withSignals);
  const contentWithSignals = await readFile(
    path.join(root, withSignals.brainDumpPath),
    "utf8",
  );
  assert.match(contentWithSignals, /## Learned/);
  assert.match(
    contentWithSignals,
    /- \[repeated-correction\] Don't mock the database in integration tests \(confidence 0\.8\)/,
  );

  const withoutSignals = await writeBrainDump({
    session: baseSession({ sessionId: "session-no-signals" }),
    events: [],
    changedFiles: [],
    narrative: { workLog: "Fix the flaky retry logic, take two" },
    observations: [],
  });
  assert.ok(withoutSignals);
  const contentWithoutSignals = await readFile(
    path.join(root, withoutSignals.brainDumpPath),
    "utf8",
  );
  assert.doesNotMatch(contentWithoutSignals, /## Learned/);
  // A session record: flat frontmatter, the fixed sections, in 01-daily/sessions/YYYY-MM/.
  assert.match(
    withoutSignals.brainDumpPath,
    /^01-daily\/sessions\/\d{4}-\d{2}\//,
  );
  assert.match(
    contentWithoutSignals,
    /^---\ntype: session\nproject: ".*"\ntask: ".*"\nprovider: ".*"\nsource: "closeout"\nstatus: (completed|failed)\nsession_id: "session-no-signals"\ndate: \d{4}-\d{2}-\d{2}\ntags: \[\]\ndistilled: false\n---\n/,
  );
  for (const heading of ["## Goal", "## Outcome"])
    assert.ok(contentWithoutSignals.includes(heading), heading);

  delete process.env.OCEAN_ROOT;
});

test("migrate-sessions moves brain-dump files into session records, never deleting one", async () => {
  const { migrateBrainDumps } = await import(
    "@ocean/brain/memory/brain-dump.js"
  );
  const { mkdir, writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-migrate-sessions-"));
  process.env.OCEAN_ROOT = root;
  const dump = path.join(root, "00-inbox", "brain-dump");
  await mkdir(dump, { recursive: true });
  await writeFile(
    path.join(dump, "2026-10-03-0915-fix-login.md"),
    "# Fix login\n",
  );
  await writeFile(path.join(dump, "notes.md"), "# undated\n");
  const target = "01-daily/sessions/2026-10/2026-10-03-0915-fix-login.md";
  assert.deepEqual(await migrateBrainDumps({ apply: false }), {
    moved: [target],
    skipped: [],
  });
  assert.equal((await readdir(dump)).length, 2);
  await migrateBrainDumps({ apply: true });
  assert.equal(
    await readFile(path.join(root, target), "utf8"),
    "---\ntype: session\ndate: 2026-10-03\nstatus: legacy\ndistilled: false\n---\n\n# Fix login\n",
  );
  assert.deepEqual(await readdir(dump), ["notes.md"]);
  delete process.env.OCEAN_ROOT;
});

// T-326: one record per session, with real words in it.

const event = (type, data, eventId = 1) => ({
  eventId,
  sessionId: "s",
  type,
  data,
  createdAt: "2026-09-21T15:52:00.000Z",
});

const digest = (overrides = {}) => ({
  title: "Fix the login redirect",
  goal: "Stop the login page looping back to itself.",
  outcome: "Found the cookie path bug.",
  decisions: ["Keep the session cookie host-only."],
  fixes: [],
  learned: [],
  next: ["Write the regression test."],
  ...overrides,
});

async function sessionFiles(root) {
  const base = path.join(root, "01-daily", "sessions");
  const months = await readdir(base).catch(() => []);
  const files = [];
  for (const month of months)
    for (const name of await readdir(path.join(base, month)))
      files.push(path.join(base, month, name));
  return files;
}

test("strips client wrapping from a message and drops a message that is only wrapping", () => {
  assert.equal(
    withoutWrappers(
      "<system-reminder>Linked sessions now</system-reminder> make it auto",
    ),
    "make it auto",
  );
  assert.equal(
    withoutWrappers(
      "<task-notification> <task-id>b47</task-id> <summary>Background command",
    ),
    "",
  );
  assert.equal(
    withoutWrappers(
      "<command-message>day-start</command-message><command-name>/day-start</command-name>",
    ),
    "",
  );
});

test("a closeout record takes the first real message as goal and the last reply as outcome", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-brain-dump-"));
  process.env.OCEAN_ROOT = root;

  const result = await writeBrainDump({
    session: baseSession({ sessionId: "real-words" }),
    events: [
      event(
        "user_input",
        "<task-notification> <task-id>x</task-id> <status>completed",
        1,
      ),
      event("user_input", "make the task state follow its PR", 2),
      event(
        "provider_output",
        "Looking at how tasks sync with pull requests today.",
        3,
      ),
      event(
        "provider_output",
        "PR #325 is merged, so in-qa is now a real task state.",
        4,
      ),
    ],
    changedFiles: [],
  });

  const text = await readFile(path.join(root, result.brainDumpPath), "utf8");
  assert.match(text, /## Goal\n\nmake the task state follow its PR\n/);
  assert.match(
    text,
    /## Outcome\n\nPR #325 is merged, so in-qa is now a real task state\.\n/,
  );
  assert.doesNotMatch(text, /task-notification/);
  assert.doesNotMatch(text, /## Verification/);
  delete process.env.OCEAN_ROOT;
});

test("a session that changed nothing and said nothing gets no record", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-brain-dump-"));
  process.env.OCEAN_ROOT = root;

  const result = await writeBrainDump({
    session: baseSession({ sessionId: "trivial" }),
    events: [event("user_input", "hi"), event("provider_output", "Hi.", 2)],
    changedFiles: [],
  });

  assert.equal(result, null);
  assert.deepEqual(await sessionFiles(root), []);
  delete process.env.OCEAN_ROOT;
});

test("two stretches of one chat merge into one record", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-brain-dump-"));
  process.env.OCEAN_ROOT = root;
  const at = "2026-09-21T15:52:00.000Z";

  const first = await writeDigestRecord({
    provider: "claude",
    sessionId: "chat-1",
    startedAt: at,
    endedAt: at,
    digest: digest(),
  });
  const second = await writeDigestRecord({
    provider: "claude",
    sessionId: "chat-1",
    startedAt: "2026-09-21T17:10:00.000Z",
    endedAt: "2026-09-21T17:10:00.000Z",
    digest: digest({
      title: "Regression test for login",
      goal: "Add a test.",
      outcome: "Redirect fixed and tested.",
      decisions: ["Test against a real cookie jar."],
      next: [],
    }),
  });

  assert.equal(second.path, first.path);
  assert.equal((await sessionFiles(root)).length, 1);
  const text = await readFile(path.join(root, first.path), "utf8");
  assert.match(text, /^source: "digest"$/m);
  assert.match(text, /# Fix the login redirect\n/);
  assert.match(
    text,
    /## Goal\n\nStop the login page looping back to itself\.\n/,
  );
  assert.match(text, /## Outcome\n\nRedirect fixed and tested\.\n/);
  assert.match(
    text,
    /- Keep the session cookie host-only\.\n- Test against a real cookie jar\./,
  );
  // The later stretch left nothing to do, so the earlier Next stands.
  assert.match(text, /## Next\n\n- Write the regression test\./);
  assert.doesNotMatch(text, /NOT PROVEN/);
  delete process.env.OCEAN_ROOT;
});

test("the chat digest replaces the thin closeout record, and a later closeout leaves it alone", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-brain-dump-"));
  process.env.OCEAN_ROOT = root;
  const session = baseSession({ sessionId: "both-writers" });
  const events = [
    event("user_input", "fix login"),
    event("provider_output", "Looking into the login redirect loop now.", 2),
  ];

  const thin = await writeBrainDump({ session, events, changedFiles: [] });
  const rich = await writeDigestRecord({
    provider: "claude",
    sessionId: "both-writers",
    startedAt: "2026-09-21T15:52:00.000Z",
    endedAt: "2026-09-21T15:52:00.000Z",
    digest: digest(),
  });

  let files = await sessionFiles(root);
  assert.equal(files.length, 1);
  assert.notEqual(rich.path, thin.brainDumpPath);
  assert.equal(path.basename(rich.path), `${stamp}-fix-the-login-redirect.md`);

  const again = await writeBrainDump({ session, events, changedFiles: [] });
  files = await sessionFiles(root);
  assert.equal(files.length, 1);
  assert.equal(again.brainDumpPath, rich.path);
  assert.match(await readFile(files[0], "utf8"), /^source: "digest"$/m);
  delete process.env.OCEAN_ROOT;
});
