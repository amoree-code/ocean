import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Records are dated on the machine's own clock: half past midnight in Baghdad (UTC+3) is still
// the previous day in UTC, and was filed under it (T-297).
test("a record written after local midnight but before UTC midnight gets today's date", () => {
  const script = `
    import { localDate, localMoment, localTime } from "@ocean/core/shared/local-date.js";
    const now = new Date(2026, 9, 30, 0, 30);
    const stored = localMoment("2026-10-29T21:30:00.000Z");
    console.log(localDate(now), now.toISOString().slice(0, 10), localDate(stored), localTime(stored));
  `;
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, TZ: "Asia/Baghdad" },
      encoding: "utf8",
    },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split(" "), [
    "2026-10-30",
    "2026-10-29",
    "2026-10-30",
    "00:30",
  ]);
});

// The same boundary through a real closeout, with the clock pinned so it holds at any hour: the
// suites that assert these paths only ever see it if they happen to run in that window (T-301).
test("a session closed after local midnight files its daily log and summary under today's date", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-local-date-"));
  const script = `
    import { mkdirSync, readdirSync } from "node:fs";
    import path from "node:path";
    import { DAILY_DIR, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
    import { SessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";
    import { finalizeSession } from "@ocean/loop/sessions/session-closeout.js";
    const at = Date.UTC(2026, 9, 29, 21, 30);
    globalThis.Date = class extends Date {
      constructor(...args) { args.length ? super(...args) : super(at); }
      static now() { return at; }
    };
    const root = process.env.OCEAN_ROOT;
    const sessions = path.join(root, SYSTEM_DIR, "sessions");
    mkdirSync(sessions, { recursive: true });
    const store = new SessionStore(path.join(sessions, "sessions.sqlite"));
    store.create({
      sessionId: "boundary-session",
      title: "Boundary test",
      taskId: null,
      handoffId: null,
      provider: "claude",
      providerSessionId: null,
      parentSessionId: null,
      profile: "reviewer",
      profileIdentity: "profile-hash",
      workingDirectory: root,
      resumeData: null,
    });
    store.updateStatus("boundary-session", "running");
    store.appendEvent("boundary-session", "user_input", "Check the date boundary");
    store.appendEvent("boundary-session", "process_exit", JSON.stringify({ exitCode: 0 }));
    store.updateStatus("boundary-session", "completed");
    await finalizeSession(store, "boundary-session", { exitCode: 0 });
    store.close();
    console.log(readdirSync(path.join(root, DAILY_DIR)).join(), readdirSync(path.join(sessions, "summaries")).join());
  `;
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, TZ: "Asia/Baghdad", OCEAN_ROOT: root },
      encoding: "utf8",
    },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split(" "), [
    "2026-10-30.md",
    "2026-10-30-boundary-session.md",
  ]);
});
