import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promoteSessionToKnowledge } from "../dist/application/memory/session-promotion.js";
import { defaultSessionStoreFactory } from "../dist/composition/runtime.js";
import { openSessionStore } from "../dist/infrastructure/persistence/session-store.js";
import { KNOWLEDGE_DIR, PERSONAL_DIR } from "../dist/paths.js";

test("promotes an approved completed session into knowledge and rejects missing approval", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ocean-session-promotion-"),
  );
  process.env.OCEAN_ROOT = root;
  await mkdir(path.join(root, PERSONAL_DIR), { recursive: true });
  await mkdir(path.join(root, KNOWLEDGE_DIR), { recursive: true });
  await writeFile(
    path.join(root, PERSONAL_DIR, "MEMORY.md"),
    "# Memory\n\n## Records (generated)\n",
  );
  await writeFile(
    path.join(root, KNOWLEDGE_DIR, "KNOWLEDGE.md"),
    "# Knowledge\n\n## Records (generated)\n",
  );
  const store = await openSessionStore();
  const sessionId = "promotion-test-session";
  store.create({
    sessionId,
    provider: "claude",
    providerSessionId: null,
    parentSessionId: null,
    profile: "reviewer",
    profileIdentity: "",
    workingDirectory: root,
    resumeData: null,
  });
  store.updateStatus(sessionId, "running");
  store.appendEvent(sessionId, "user_input", "Review the project");
  store.appendEvent(sessionId, "provider_output", "The project is healthy.");
  store.appendEvent(
    sessionId,
    "evidence",
    JSON.stringify({ result: "proven" }),
  );
  store.updateStatus(sessionId, "completed");
  store.close();
  await assert.rejects(
    promoteSessionToKnowledge(sessionId, defaultSessionStoreFactory),
    /explicit approval/,
  );
  const result = await promoteSessionToKnowledge(
    sessionId,
    defaultSessionStoreFactory,
    "knowledge/results",
    true,
  );
  assert.equal(result.applied, true);
  assert.match(
    await readFile(path.join(root, result.file), "utf8"),
    /human-approved/,
  );
  delete process.env.OCEAN_ROOT;
});
