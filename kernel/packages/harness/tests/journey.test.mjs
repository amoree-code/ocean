import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { approveCandidate } from "@ocean/brain/memory/memory-review.js";
import { pickResurface } from "@ocean/services/brief/brief.js";
import {
  analyzeSessions,
  errorShape,
  proposeTelemetry,
} from "@ocean/services/journey/telemetry.js";

// T-314 journey: telemetry proposes backlog lines; the brief resurfaces one old thing.

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-journey-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

const write = async (root, file, text) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
};

test("telemetry groups the same error across sessions and flags failing providers", () => {
  assert.equal(
    errorShape("ENOENT /srv/a/x.json at line 12"),
    errorShape("ENOENT /tmp/b/y.json at line 99"),
  );
  const sessions = [1, 2, 3, 4, 5].map((n) => ({
    sessionId: `s${n}`,
    provider: n <= 4 ? "codex" : "claude",
    status: n <= 3 ? "failed" : "completed",
    createdAt: `2026-11-1${n}T00:00:00.000Z`,
  }));
  const events = {
    s1: [{ type: "error", data: "spawn codex ENOENT /a/1" }],
    s2: [{ type: "error", data: "spawn codex ENOENT /b/2" }],
    s3: [{ type: "provider_blocked", data: "spawn codex ENOENT /c/3" }],
    s4: [{ type: "text", data: "spawn codex ENOENT /d/4" }],
  };
  const findings = analyzeSessions(
    sessions,
    (id) => events[id] ?? [],
    "2026-11-01T00:00:00.000Z",
  );
  assert.deepEqual(
    findings.map((f) => f.line),
    [
      "Recurring error in 3 sessions: spawn codex ENOENT <path>",
      "codex: 3 of 4 sessions failed or never finished",
    ],
  );
  assert.deepEqual(
    analyzeSessions(
      sessions,
      (id) => events[id] ?? [],
      "2026-11-20T00:00:00.000Z",
    ),
    [],
  );
});

test("telemetry findings become todo candidates that land in the backlog only on approval", async () => {
  await withRoot(async (root) => {
    for (const [dir, index] of [
      ["02-personal", "MEMORY.md"],
      ["05-knowledge", "KNOWLEDGE.md"],
    ])
      await write(root, `${dir}/${index}`, "# Index\n");
    const finding = {
      line: "codex: 3 of 4 sessions failed or never finished",
      sessions: 3,
    };
    assert.deepEqual(await proposeTelemetry([finding], false), [finding.line]);
    const [candidate] = await proposeTelemetry([finding], true);
    await assert.rejects(readFile(path.join(root, "04-projects/backlog.md")));
    await approveCandidate({ id: path.basename(candidate, ".md") });
    assert.match(
      await readFile(path.join(root, "04-projects/backlog.md"), "utf8"),
      /- \[TODO\] \(P2\) ocean — codex: 3 of 4 sessions failed or never finished/,
    );
  });
});

test("resurface picks the decision verified longest ago past 90 days, else the quietest note", async () => {
  await withRoot(async (root) => {
    assert.equal(await pickResurface("2026-11-16"), null);
    await write(root, "07-notes/a.md", "a\n");
    await write(root, "07-notes/b.md", "b\n");
    const old = new Date("2026-01-01");
    await utimes(path.join(root, "07-notes/b.md"), old, old);
    assert.match(await pickResurface("2026-11-16"), /^07-notes\/b\.md — /);
    await write(
      root,
      "05-knowledge/decisions/fresh.md",
      "---\nlast_verified: 2026-11-01\n---\n",
    );
    await write(
      root,
      "05-knowledge/decisions/old.md",
      "---\nlast_verified: 2026-05-01\n---\n",
    );
    await write(
      root,
      "05-knowledge/decisions/older.md",
      "---\nlast_verified: 2026-03-01\nstatus: retired\n---\n",
    );
    assert.equal(
      await pickResurface("2026-11-16"),
      "05-knowledge/decisions/old.md — needs re-evaluation (last verified 2026-05-01)",
    );
  });
});
