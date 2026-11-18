import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  coreSkillReports,
  syncCoreSkills,
} from "@ocean/market/skills/core-skill-sync.js";

test("core skill sync copies canonical skills and preserves non-core skills", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocean-skills-"));
  try {
    await mkdir(path.join(home, ".claude", "skills", "custom"), {
      recursive: true,
    });
    await writeFile(
      path.join(home, ".claude", "skills", "custom", "SKILL.md"),
      "custom",
    );
    await mkdir(path.join(home, ".codex", "skills"), { recursive: true });

    const synced = await syncCoreSkills(home);
    assert.equal(
      synced.find((item) => item.client === "claude")?.status,
      "synchronized",
    );
    assert.equal(
      synced.find((item) => item.client === "codex")?.status,
      "synchronized",
    );
    assert.equal(
      await readFile(
        path.join(home, ".claude", "skills", "custom", "SKILL.md"),
        "utf8",
      ),
      "custom",
    );

    const reports = await coreSkillReports(home);
    assert.equal(
      reports.find((item) => item.client === "claude")?.status,
      "synchronized",
    );
    await writeFile(
      path.join(home, ".claude", "skills", "catch-up", "SKILL.md"),
      "drift",
    );
    assert.equal(
      reports.find((item) => item.client === "codex")?.status,
      "synchronized",
    );
    assert.equal(
      (await coreSkillReports(home)).find((item) => item.client === "claude")
        ?.status,
      "drifted",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("core skill sync replaces a dangling skill link instead of throwing ENOENT", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocean-skills-"));
  try {
    const root = path.join(home, ".hermes", "skills");
    await mkdir(root, { recursive: true });
    await symlink(
      path.join(home, "moved-away"),
      path.join(root, "verification"),
      "dir",
    );

    await syncCoreSkills(home);

    await stat(path.join(root, "verification", "SKILL.md"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("keepNewer copies missing core skills but keeps a client copy edited after the engine's", async () => {
  const { utimes } = await import("node:fs/promises");
  const home = await mkdtemp(path.join(os.tmpdir(), "ocean-skills-"));
  try {
    await mkdir(path.join(home, ".claude", "skills"), { recursive: true });
    await syncCoreSkills(home);
    const edited = path.join(home, ".claude", "skills", "catch-up", "SKILL.md");
    const stale = path.join(
      home,
      ".claude",
      "skills",
      "verification",
      "SKILL.md",
    );
    await writeFile(edited, "my own catch-up");
    await writeFile(stale, "an old engine version");
    const future = Date.now() / 1000 + 3600;
    await utimes(edited, future, future);
    await utimes(stale, 1_000, 1_000);
    await rm(path.join(home, ".claude", "skills", "loop"), { recursive: true });

    const [claude] = (await syncCoreSkills(home, { keepNewer: true })).filter(
      (item) => item.client === "claude",
    );
    assert.deepEqual(claude.copied.sort(), ["loop", "verification"]);
    assert.equal(await readFile(edited, "utf8"), "my own catch-up");
    assert.notEqual(await readFile(stale, "utf8"), "an old engine version");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
