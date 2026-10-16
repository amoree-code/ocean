import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compressContext } from "@ocean/context/context/context-compression.js";
import { defaultSkillNames } from "@ocean/core/domain/skills/default-skills.js";
import { openSessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";
import { listSkillCandidates } from "@ocean/market/skills/skill-curation.js";
import {
  listObservations,
  observeSession,
  reviewObservation,
} from "@ocean/market/skills/task-observer.js";
import { defaultSessionStoreFactory } from "../dist/composition/runtime.js";

test("default skill policy stays small and verification-first", () => {
  assert.deepEqual(defaultSkillNames("general assistant"), [
    "design-thinking",
    "business-logic",
    "core-thinking",
    "verification",
    "loop",
    "use-browser",
  ]);
  assert.deepEqual(defaultSkillNames("developer"), [
    "design-thinking",
    "business-logic",
    "core-thinking",
    "verification",
    "loop",
    "use-browser",
  ]);
});

test("compression preserves required evidence and records recovery metadata", () => {
  const source = [
    "# Tool output",
    "changed files: src/app.ts",
    "verification: pnpm test passed",
    "security warning: never expose sensitive values",
    ...Array.from(
      { length: 80 },
      (_, index) => `repeated log line ${index % 4}`,
    ),
    "next action: inspect the remaining failure",
  ].join("\n");
  const result = compressContext({
    sourceId: "tool-1",
    content: source,
    budget: 260,
  });
  assert.equal(result.safeToUse, true);
  assert.equal(result.method, "ocean-bounded-v1");
  assert.ok(result.compressedBytes <= 260);
  assert.ok(result.originalBytes > result.compressedBytes);
  assert.match(result.content, /changed files/);
  assert.match(result.content, /verification/);
  assert.match(result.content, /next action/);
  assert.equal(result.recoveryRef, "tool-1");
});

test("compression falls back to bounded original when required evidence cannot fit safely", () => {
  const result = compressContext({
    sourceId: "tiny",
    content: "security warning: keep this",
    budget: 8,
  });
  assert.equal(result.safeToUse, false);
  assert.equal(result.method, "fallback-original-bounded");
  assert.equal(result.compressedBytes, Buffer.byteLength(result.content));
  assert.ok(result.compressedBytes <= 8);
});

test("observer records proven repeated work without creating or promoting a skill", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-t194-observer-"));
  process.env.OCEAN_ROOT = root;
  const store = await openSessionStore();
  const sessionId = "observer-session";
  store.create({
    sessionId,
    provider: "codex",
    providerSessionId: null,
    parentSessionId: null,
    profile: "developer",
    profileIdentity: "profile-hash",
    workingDirectory: root,
    resumeData: null,
    taskId: "T-194",
  });
  store.updateStatus(sessionId, "running");
  store.appendEvent(
    sessionId,
    "provider_output",
    "Decision: use a bounded verification checklist.\nDecision: use a bounded verification checklist.",
  );
  store.appendEvent(
    sessionId,
    "evidence",
    JSON.stringify({ result: "proven", criterion: "tests pass" }),
  );
  store.updateStatus(sessionId, "completed");
  store.close();
  try {
    const observations = await observeSession(
      sessionId,
      defaultSessionStoreFactory,
    );
    assert.ok(observations.length >= 1);
    const observation = observations.find(
      (item) => item.signalType === "explicit-decision",
    );
    assert.ok(observation);
    assert.equal(observation.status, "observed");
    assert.equal(observation.sourceSessionId, sessionId);
    assert.equal(observation.taskId, "T-194");
    assert.ok(observation.evidenceRefs.length > 0);
    assert.deepEqual(await listObservations(), observations);
    assert.equal(
      (await reviewObservation(observations[0].observationId, "discarded"))
        .status,
      "discarded",
    );
  } finally {
    delete process.env.OCEAN_ROOT;
  }
});

test("observer only treats real user corrections as repeated-correction, not provider output mentioning those words", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-t194-observer-"));
  process.env.OCEAN_ROOT = root;
  const store = await openSessionStore();
  const sessionId = "observer-correction-session";
  store.create({
    sessionId,
    provider: "codex",
    providerSessionId: null,
    parentSessionId: null,
    profile: "developer",
    profileIdentity: "profile-hash",
    workingDirectory: root,
    resumeData: null,
    taskId: null,
  });
  store.updateStatus(sessionId, "running");
  store.appendEvent(
    sessionId,
    "provider_output",
    "--acp (Deprecated, use `kimi acp` instead) Run as ACP server.",
  );
  store.appendEvent(
    sessionId,
    "user_input",
    "no, use pnpm instead of npm for this repo",
  );
  store.appendEvent(
    sessionId,
    "evidence",
    JSON.stringify({ result: "proven", criterion: "tests pass" }),
  );
  store.updateStatus(sessionId, "completed");
  store.close();
  try {
    const observations = await observeSession(
      sessionId,
      defaultSessionStoreFactory,
    );
    const corrections = observations.filter(
      (item) => item.signalType === "repeated-correction",
    );
    assert.equal(corrections.length, 1);
    assert.match(corrections[0].summary, /use pnpm instead of npm/);
  } finally {
    delete process.env.OCEAN_ROOT;
  }
});

test("approving an observation creates a skill candidate, not just a status flag", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-t194-observer-"));
  process.env.OCEAN_ROOT = root;
  const store = await openSessionStore();
  const sessionId = "observer-approval-session";
  store.create({
    sessionId,
    provider: "codex",
    providerSessionId: null,
    parentSessionId: null,
    profile: "developer",
    profileIdentity: "profile-hash",
    workingDirectory: root,
    resumeData: null,
    taskId: null,
  });
  store.updateStatus(sessionId, "running");
  store.appendEvent(
    sessionId,
    "provider_output",
    "Decision: use a bounded verification checklist.\nDecision: use a bounded verification checklist.",
  );
  store.appendEvent(
    sessionId,
    "evidence",
    JSON.stringify({ result: "proven", criterion: "tests pass" }),
  );
  store.updateStatus(sessionId, "completed");
  store.close();
  try {
    const [observation] = await observeSession(
      sessionId,
      defaultSessionStoreFactory,
    );
    assert.equal(observation.skillCandidateId, null);
    const reviewed = await reviewObservation(
      observation.observationId,
      "approved",
    );
    assert.ok(reviewed.skillCandidateId);
    const candidates = await listSkillCandidates();
    const candidate = candidates.find(
      (item) => item.id === reviewed.skillCandidateId,
    );
    assert.ok(candidate);
    assert.equal(candidate.status, "candidate");
    assert.equal(candidate.sourceSessionId, sessionId);
    assert.equal(candidate.instructions, observation.summary);
  } finally {
    delete process.env.OCEAN_ROOT;
  }
});
