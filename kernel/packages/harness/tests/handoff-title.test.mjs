import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHandoffWithStore } from "@ocean/loop/handoff/handoff-service.js";
import { SessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";

// Session telemetry (T-314) found closeout failing in 113 sessions: a session's title defaults
// to "", and the handoff kept it, so the schema rejected the handoff (zod too_small on title).
test("a session with no title still gets a handoff, with the default title", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-handoff-title-"));
  const store = new SessionStore(path.join(root, "sessions.sqlite"));
  try {
    store.create({
      sessionId: "untitled",
      provider: "claude",
      providerSessionId: null,
      parentSessionId: null,
      profile: "default",
      profileIdentity: "",
      workingDirectory: root,
      resumeData: null,
    });
    assert.equal(store.get("untitled").title, "");
    const handoff = await createHandoffWithStore(store, {
      sessionId: "untitled",
      task: null,
      title: "  ",
    });
    assert.equal(handoff.title, "Ocean session handoff");
  } finally {
    store.close();
  }
});
