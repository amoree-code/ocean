import assert from "node:assert/strict";
import test from "node:test";
import { buildVerificationReport } from "@ocean/brain/evidence/verification-report.js";
import { validateEvidence } from "@ocean/core/domain/evidence/evidence.js";

const record = (result, id = "e1") =>
  validateEvidence({
    evidenceId: id,
    sessionId: "s1",
    type: "test",
    source: "unit-test",
    observedAt: "2026-09-10T00:00:00.000Z",
    result,
    criterion: "criterion",
    payload: "{}",
  });
test("validates bounded evidence and builds a deterministic report", () => {
  const records = [
    record("proven"),
    record("not_proven", "e2"),
    record("limitation", "e3"),
  ];
  const first = buildVerificationReport(records);
  const second = buildVerificationReport(records);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.proven.length, 1);
  assert.equal(first.notProven.length, 1);
  assert.equal(first.limitations.length, 1);
});
test("rejects evidence payloads over the bounded limit", () =>
  assert.throws(() =>
    validateEvidence({ ...record("proven"), payload: "x".repeat(64_001) }),
  ));
