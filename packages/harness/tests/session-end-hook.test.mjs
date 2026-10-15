import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  claudeSessionEndHook,
  readTranscriptEvents,
} from "../dist/application/hooks/session-end-hook.js";
import { defaultSessionStoreFactory } from "../dist/composition/runtime.js";
import { openSessionStore } from "../dist/infrastructure/persistence/session-store.js";
import { INBOX_DIR, SYSTEM_DIR } from "../dist/paths.js";

test("readTranscriptEvents extracts bounded user/assistant text turns and skips everything else", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-transcript-"));
  const file = path.join(dir, "transcript.jsonl");
  const lines = [
    JSON.stringify({ type: "queue-operation", operation: "enqueue" }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "rename amir to ameer" },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: {} }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Renamed it." }],
      },
    }),
  ];
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");

  const events = await readTranscriptEvents(file);
  assert.deepEqual(events, [
    { type: "user_input", data: "rename amir to ameer" },
    { type: "provider_output", data: "Renamed it." },
  ]);
});

test("readTranscriptEvents returns no events for a missing or oversized transcript", async () => {
  assert.deepEqual(await readTranscriptEvents("/does/not/exist.jsonl"), []);
});

test("claudeSessionEndHook registers a desktop session from its transcript and runs the closeout pipeline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-session-end-hook-"));
  const projectDir = path.join(root, "project");
  await mkdir(path.join(projectDir, ".git"), { recursive: true });
  process.env.OCEAN_ROOT = root;

  const transcriptPath = path.join(root, "transcript.jsonl");
  await writeFile(
    transcriptPath,
    `${[
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "wire the brain-dump hook" },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Wired it up." }],
        },
      }),
    ].join("\n")}\n`,
    "utf8",
  );

  await claudeSessionEndHook(
    {
      session_id: "desktop-hook-session-1",
      transcript_path: transcriptPath,
      cwd: projectDir,
      hook_event_name: "SessionEnd",
      reason: "other",
    },
    defaultSessionStoreFactory,
  );

  const store = await openSessionStore();
  const saved = store.get("desktop-hook-session-1");
  assert.ok(saved);
  assert.equal(saved.profile, "desktop:claude");
  assert.equal(saved.closeoutStatus, "completed");
  store.close();

  const today = new Date().toISOString().slice(0, 10);
  const summary = await readFile(
    path.join(
      root,
      SYSTEM_DIR,
      "sessions",
      "summaries",
      `${today}-desktop-hook-session-1.md`,
    ),
    "utf8",
  );
  assert.match(summary, /wire the brain-dump hook/);
  assert.match(summary, /Wired it up\./);

  const brainDumpFiles = await readdir(
    path.join(root, INBOX_DIR, "brain-dump"),
  );
  assert.equal(brainDumpFiles.length, 1);
  const brainDump = await readFile(
    path.join(root, INBOX_DIR, "brain-dump", brainDumpFiles[0]),
    "utf8",
  );
  assert.match(brainDump, /wire the brain-dump hook/);
  assert.match(brainDump, /Session id: desktop-hook-session-1/);

  delete process.env.OCEAN_ROOT;
});

test("claudeSessionEndHook is a no-op without a session_id and never throws", async () => {
  await assert.doesNotReject(
    claudeSessionEndHook({}, defaultSessionStoreFactory),
  );
});

test("claudeSessionEndHook is idempotent for a session that already closed out", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-session-end-hook-"));
  process.env.OCEAN_ROOT = root;

  const payload = {
    session_id: "desktop-hook-session-2",
    cwd: root,
    hook_event_name: "SessionEnd",
    reason: "other",
  };
  await claudeSessionEndHook(payload, defaultSessionStoreFactory);
  await assert.doesNotReject(
    claudeSessionEndHook(payload, defaultSessionStoreFactory),
  );

  delete process.env.OCEAN_ROOT;
});
