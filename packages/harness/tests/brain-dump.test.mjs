import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeBrainDump } from "../dist/application/memory/brain-dump.js";
import { INBOX_DIR } from "../dist/paths.js";

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
    "2026-09-21-1552-wire-the-brain-dump-hook-for-desktop-sessions.md",
  );
  assert.doesNotMatch(filename, /11112222-3333-4444-5555-666677778888/);

  delete process.env.OCEAN_ROOT;
});

test("falls back to the project name, then the short session id, when the title has no usable Latin slug", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-brain-dump-"));
  process.env.OCEAN_ROOT = root;

  const withProject = await writeBrainDump({
    session: baseSession({ workingDirectory: "/opt/projects/ameer" }),
    events: [],
    changedFiles: [],
    narrative: { workLog: "شنو صار اليوم" },
  });
  assert.ok(withProject);
  assert.equal(
    path.basename(withProject.brainDumpPath),
    "2026-09-21-1552-ameer.md",
  );

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
  assert.equal(
    path.basename(noProject.brainDumpPath),
    "2026-09-21-1552-abcdef12.md",
  );

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
    "2026-09-21-1552-fix-the-login-bug.md",
  );
  assert.equal(
    path.basename(second.brainDumpPath),
    "2026-09-21-1552-fix-the-login-bug-2.md",
  );

  const files = await readdir(path.join(root, INBOX_DIR, "brain-dump"));
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
  assert.match(contentWithSignals, /## Signals/);
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
  assert.doesNotMatch(contentWithoutSignals, /## Signals/);

  delete process.env.OCEAN_ROOT;
});
