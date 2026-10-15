import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateSessionEntryContract } from "@ocean/core/domain/sessions/entry-contract.js";
import { openSessionStore } from "../dist/infrastructure/persistence/session-store.js";
import { runClientTestCommand } from "../dist/interfaces/cli/client-test-command.js";

test("validates the full-head entry contract", () => {
  assert.deepEqual(
    validateSessionEntryContract({
      entryPoint: "ocean-run",
      controlLevel: "full-head",
      inputCapture: "semantic",
      contextTransport: "profile-context-and-provider-adapter",
      policyEnforcement: "profile-and-run-contract",
      promotion: "explicit-review",
      resume: "provider-session-id",
    }).controlLevel,
    "full-head",
  );
});

for (const [label, entryPoint, eventType] of [
  ["new", "ocean-run", "ocean_bootstrap"],
]) {
  test(`client-test reads ${label} entry contract and bootstrap events`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ocean-client-test-"));
    const previous = process.env.OCEAN_ROOT;
    process.env.OCEAN_ROOT = root;
    const logs = [];
    const log = console.log;
    try {
      const store = await openSessionStore();
      store.create({
        sessionId: "s-1",
        provider: "claude",
        providerSessionId: null,
        parentSessionId: null,
        profile: "developer",
        profileIdentity: "h",
        workingDirectory: root,
        resumeData: null,
        taskId: null,
      });
      store.appendEvent(
        "s-1",
        "session_entry_contract",
        JSON.stringify({ entryPoint }),
      );
      store.appendEvent(
        "s-1",
        eventType,
        JSON.stringify({ provider: "claude", bytes: 7 }),
      );
      store.close();
      console.log = (line) => logs.push(line);
      await runClientTestCommand("claude", true);
    } finally {
      console.log = log;
      if (previous === undefined) delete process.env.OCEAN_ROOT;
      else process.env.OCEAN_ROOT = previous;
    }
    const report = JSON.parse(logs.join("\n"));
    assert.equal(report.latestSession.entryContract.entryPoint, entryPoint);
    assert.equal(report.latestSession.bootstrapManifest.bytes, 7);
  });
}

test("rejects an entry contract that promises an unknown control level", () => {
  assert.throws(
    () =>
      validateSessionEntryContract({
        entryPoint: "terminal-shim",
        controlLevel: "unsupported",
        inputCapture: "bounded-terminal",
        contextTransport: "manifest-only",
        policyEnforcement: "shim-lifecycle-and-provider-owned-policy",
        promotion: "explicit-review",
        resume: "unsupported",
      }),
    /Invalid (?:enum value|option)/,
  );
});
