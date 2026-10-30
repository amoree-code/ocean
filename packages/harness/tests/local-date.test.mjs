import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
