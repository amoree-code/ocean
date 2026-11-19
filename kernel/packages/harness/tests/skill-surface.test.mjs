import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  coreSkillNames,
  syncCoreSkills,
} from "@ocean/market/skills/core-skill-sync.js";
import { skillSurfaceReport } from "@ocean/market/skills/skill-hub.js";

// T-319 C5: one check that every installed client holds the skills Ocean keeps for it. Temp
// homes and hubs only.

async function skill(root, name) {
  await mkdir(path.join(root, name), { recursive: true });
  await writeFile(path.join(root, name, "SKILL.md"), `# ${name}\n`);
}

test("installed clients are judged against core plus, for copy clients, the hub", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocean-surface-"));
  const hub = path.join(home, "hub");
  try {
    await skill(hub, "research");
    await mkdir(path.join(hub, "not-a-skill"), { recursive: true });
    const claude = path.join(home, ".claude", "skills");
    const cursor = path.join(home, ".cursor", "skills");
    await mkdir(claude, { recursive: true });
    await mkdir(cursor, { recursive: true });
    await syncCoreSkills(home);
    await skill(claude, "research");
    await skill(claude, "my-own");

    const ok = await skillSurfaceReport({ home, hub });
    assert.equal(ok.consistent, true);
    const row = (report, client) =>
      report.clients.find((item) => item.client === client);
    const core = (await coreSkillNames()).length;
    assert.equal(row(ok, "claude").expected, core + 1);
    assert.deepEqual(row(ok, "claude").extra, ["my-own"]);
    // Cursor gets core skills only; codex has no skills folder, so it is listed, not judged.
    assert.equal(row(ok, "cursor").expected, core);
    assert.equal(row(ok, "codex").installed, false);
    assert.deepEqual(row(ok, "codex").missing, []);

    await rm(path.join(claude, "research"), { recursive: true });
    await rm(path.join(cursor, "verification"), { recursive: true });
    const gap = await skillSurfaceReport({ home, hub });
    assert.equal(gap.consistent, false);
    assert.deepEqual(row(gap, "claude").missing, ["research"]);
    assert.deepEqual(row(gap, "cursor").missing, ["verification"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("`ocean skill doctor` reports core and surface, and fails on a gap", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocean-surface-cli-"));
  try {
    await mkdir(path.join(home, ".gemini", "skills"), { recursive: true });
    const run = () =>
      spawnSync(
        process.execPath,
        [path.resolve("dist/main.js"), "skill", "doctor"],
        { encoding: "utf8", env: { ...process.env, HOME: home } },
      );
    const gap = run();
    assert.equal(gap.status, 1);
    assert.match(gap.stderr, /NOT CONSISTENT: gemini lacks /);
    const report = JSON.parse(gap.stdout);
    assert.ok(Array.isArray(report.core));
    assert.equal(report.surface.consistent, false);

    await syncCoreSkills(home);
    const ok = run();
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).surface.consistent, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
