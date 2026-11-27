import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listToolBytes } from "../dist/application/clients/mcp-schema-cost.js";
import { profileDoctor } from "../dist/application/profiles/profile-doctor.js";

const now = new Date("2026-11-27T12:00:00Z");
const line = (fields) =>
  JSON.stringify({ ts: "2026-11-26T10:00:00Z", source: "hook", ...fields });

test("profiles doctor turns repeated routing misses into suggestions (T-338 P5)", () => {
  const log = [
    ...Array.from({ length: 3 }, () =>
      line({ project: "shop", profile: "base", confidence: "none" }),
    ),
    ...Array.from({ length: 3 }, () =>
      line({
        project: "web",
        profile: "frontend",
        confidence: "high",
        secondary: ["marketing-ads"],
      }),
    ),
    line({ project: "unbound", profile: "base", confidence: "none" }),
    line({ project: "web", profile: "renamed", confidence: "high" }),
    line({
      task: "T-1",
      profile: "backend",
      override: true,
      suggested: { profile: "base" },
    }),
    line({
      task: "T-2",
      profile: "backend",
      override: true,
      suggested: { profile: "base" },
    }),
    // Outside the window, and a broken line.
    JSON.stringify({
      ts: "2026-09-01T00:00:00Z",
      project: "old",
      profile: "base",
      confidence: "none",
    }),
    "{not json",
  ].join("\n");
  const report = profileDoctor(
    log,
    ["base", "frontend", "backend", "marketing-ads"],
    {
      now,
      days: 30,
    },
  );
  assert.equal(report.sessions, 8);
  assert.equal(report.tasks, 2);
  assert.equal(report.unreadable, 1);
  assert.equal(report.byProfile.base, 4);
  const kinds = report.findings.map((finding) => finding.kind).sort();
  assert.deepEqual(kinds, [
    "recurring-secondary",
    "task-override",
    "unknown-profile",
    "unrouted-project",
  ]);
  const unrouted = report.findings.find((f) => f.kind === "unrouted-project");
  assert.match(unrouted.detail, /shop/);
  assert.match(unrouted.suggestion, /ocean project register/);
  assert.match(
    report.findings.find((f) => f.kind === "recurring-secondary").suggestion,
    /add marketing-ads to web's project.json profiles/,
  );
  assert.match(
    report.findings.find((f) => f.kind === "task-override").detail,
    /base → backend by hand 2 times \(T-1, T-2\)/,
  );
  // A project with one matched session is not a finding; nor is an unbound folder.
  assert.ok(!report.findings.some((f) => /unbound/.test(f.detail)));
  assert.deepEqual(profileDoctor("", ["base"], { now }).findings, []);
});

test("context cost measures Ocean's MCP schemas over a real tools/list", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-mcp-cost-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    const listing = await listToolBytes(
      [process.execPath, path.resolve("dist/main.js"), "mcp", "serve"],
      root,
    );
    // T-339: 8 core tools, at most 6,000 B of schemas.
    assert.equal(listing.tools, 8);
    assert.ok(
      listing.bytes > 0 && listing.bytes <= 6_000,
      String(listing.bytes),
    );
    assert.equal(
      await listToolBytes([process.execPath, "-e", "process.exit(0)"], root),
      null,
    );
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});
