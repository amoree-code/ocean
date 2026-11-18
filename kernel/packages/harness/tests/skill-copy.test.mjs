import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  copyClientSkills,
  hubSkillHashes,
  pruneClientSkills,
} from "@ocean/market/skills/skill-hub.js";

async function skill(root, name, files) {
  for (const [file, body] of Object.entries(files)) {
    const target = path.join(root, name, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
}

// A hub with one nested skill and one flat one, plus two clients (codex, claude) and a
// foreign skill a client owns itself.
async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "skill-copy-"));
  const hub = path.join(base, "hub");
  const home = path.join(base, "home");
  const archive = path.join(base, "archive");
  await skill(hub, "alpha", {
    "SKILL.md": "alpha",
    "scripts/run.sh": "echo hi",
  });
  await skill(hub, "beta", { "SKILL.md": "beta" });
  await mkdir(path.join(home, ".claude", "skills"), { recursive: true });
  await mkdir(path.join(home, ".codex", "skills"), { recursive: true });
  return { base, hub, home, archive };
}

test("dry run reports the work and changes nothing", async () => {
  const { base, hub, home, archive } = await fixture();
  try {
    const { actions } = await copyClientSkills({ hub, home, archive });
    assert.equal(actions.length, 4);
    assert.ok(actions.every((a) => a.action === "create"));
    assert.deepEqual(await readdir(path.join(home, ".claude", "skills")), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("copies whole skill directories, nested files included", async () => {
  const { base, hub, home, archive } = await fixture();
  try {
    await copyClientSkills({ hub, home, archive, apply: true });
    assert.equal(
      await readFile(
        path.join(home, ".codex", "skills", "alpha", "scripts", "run.sh"),
        "utf8",
      ),
      "echo hi",
    );
    const info = await lstat(path.join(home, ".claude", "skills", "beta"));
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("replaces a symlink with a copy and leaves the hub untouched", async () => {
  const { base, hub, home, archive } = await fixture();
  try {
    const link = path.join(home, ".claude", "skills", "alpha");
    await symlink(path.join(hub, "alpha"), link, "dir");
    const { actions } = await copyClientSkills({
      hub,
      home,
      archive,
      apply: true,
    });
    assert.equal(
      actions.find((a) => a.client === "claude" && a.skill === "alpha")?.action,
      "unlink",
    );
    assert.ok(!(await lstat(link)).isSymbolicLink());
    assert.equal(
      await readFile(path.join(hub, "alpha", "SKILL.md"), "utf8"),
      "alpha",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a drifted real directory is backed up, not deleted", async () => {
  const { base, hub, home, archive } = await fixture();
  try {
    await skill(path.join(home, ".codex", "skills"), "beta", {
      "SKILL.md": "old beta",
    });
    const { actions, backup } = await copyClientSkills({
      hub,
      home,
      archive,
      apply: true,
    });
    assert.equal(
      actions.find((a) => a.client === "codex" && a.skill === "beta")?.action,
      "replace",
    );
    assert.equal(
      await readFile(path.join(backup, "codex", "beta", "SKILL.md"), "utf8"),
      "old beta",
    );
    assert.equal(
      await readFile(
        path.join(home, ".codex", "skills", "beta", "SKILL.md"),
        "utf8",
      ),
      "beta",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a changed nested script counts as drift", async () => {
  const { base, hub, home, archive } = await fixture();
  try {
    await copyClientSkills({ hub, home, archive, apply: true });
    await writeFile(
      path.join(home, ".claude", "skills", "alpha", "scripts", "run.sh"),
      "tampered",
    );
    const { actions } = await copyClientSkills({ hub, home, archive });
    assert.equal(
      actions.find((a) => a.client === "claude" && a.skill === "alpha")?.action,
      "replace",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("is idempotent and leaves foreign skills alone", async () => {
  const { base, hub, home, archive } = await fixture();
  try {
    await skill(path.join(home, ".claude", "skills"), "foreign", {
      "SKILL.md": "mine",
    });
    await copyClientSkills({ hub, home, archive, apply: true });
    const again = await copyClientSkills({ hub, home, archive, apply: true });
    assert.ok(again.actions.every((a) => a.action === "synchronized"));
    assert.equal(again.backup, null);
    assert.equal(
      await readFile(
        path.join(home, ".claude", "skills", "foreign", "SKILL.md"),
        "utf8",
      ),
      "mine",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a plain file where a skill belongs is backed up, not fatal", async () => {
  const { base, hub, home, archive } = await fixture();
  try {
    await writeFile(path.join(home, ".claude", "skills", "beta"), "stray");
    const { actions, backup } = await copyClientSkills({
      hub,
      home,
      archive,
      apply: true,
    });
    assert.equal(
      actions.find((a) => a.client === "claude" && a.skill === "beta")?.action,
      "replace",
    );
    assert.equal(
      await readFile(path.join(backup, "claude", "beta"), "utf8"),
      "stray",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a link outside the hub is kept in the backup, not lost", async () => {
  const { base, hub, home, archive } = await fixture();
  try {
    const other = path.join(base, "other", "beta");
    await skill(path.join(base, "other"), "beta", { "SKILL.md": "other" });
    await symlink(other, path.join(home, ".codex", "skills", "beta"), "dir");
    const { backup } = await copyClientSkills({
      hub,
      home,
      archive,
      apply: true,
    });
    assert.ok(
      (await lstat(path.join(backup, "codex", "beta"))).isSymbolicLink(),
    );
    assert.equal(await readFile(path.join(other, "SKILL.md"), "utf8"), "other");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a skill containing a symlink fails alone; the rest still copy", async () => {
  const { base, hub, home, archive } = await fixture();
  try {
    await symlink(
      path.join(base, "home"),
      path.join(hub, "alpha", "leak"),
      "dir",
    );
    const { actions } = await copyClientSkills({
      hub,
      home,
      archive,
      apply: true,
    });
    const failed = actions.find((a) => a.skill === "alpha");
    assert.equal(failed?.action, "failed");
    assert.match(failed?.error ?? "", /symlink/);
    assert.equal(
      await readFile(
        path.join(home, ".claude", "skills", "beta", "SKILL.md"),
        "utf8",
      ),
      "beta",
    );
    assert.deepEqual(
      (await readdir(path.join(home, ".claude", "skills"))).sort(),
      ["beta"],
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// Sets every file and folder under `dir` to `when` (seconds), so the newer-edit rule is tested
// without waiting on the clock.
async function touchTree(dir, when) {
  const { utimes } = await import("node:fs/promises");
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await touchTree(full, when);
    await utimes(full, when, when);
  }
  await utimes(dir, when, when);
}

test("auto copies new and hub-updated skills but keeps a newer edit made in a client", async () => {
  const { base, hub, home, archive } = await fixture();
  try {
    await copyClientSkills({ hub, home, archive, apply: true, auto: true });
    const claudeAlpha = path.join(home, ".claude", "skills", "alpha");
    const claudeBeta = path.join(home, ".claude", "skills", "beta");
    // The owner edits alpha inside Claude (newer); the hub updates beta (newer than the copy).
    await writeFile(path.join(claudeAlpha, "SKILL.md"), "alpha, my edit");
    await touchTree(path.join(hub, "alpha"), 1_000);
    await touchTree(claudeAlpha, 2_000);
    await writeFile(path.join(hub, "beta", "SKILL.md"), "beta v2");
    await touchTree(claudeBeta, 1_000);
    await touchTree(path.join(hub, "beta"), 2_000);
    // A skill made in the hub after the first sync.
    await skill(hub, "gamma", { "SKILL.md": "gamma" });

    const { actions, backup } = await copyClientSkills({
      hub,
      home,
      archive,
      apply: true,
      auto: true,
      clients: ["claude"],
    });
    const by = Object.fromEntries(actions.map((a) => [a.skill, a.action]));
    assert.deepEqual(by, { alpha: "kept", beta: "replace", gamma: "create" });
    assert.equal(
      await readFile(path.join(claudeAlpha, "SKILL.md"), "utf8"),
      "alpha, my edit",
    );
    assert.equal(
      await readFile(path.join(claudeBeta, "SKILL.md"), "utf8"),
      "beta v2",
    );
    assert.ok(backup, "the replaced copy is backed up");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("auto with no hub copies nothing and does not throw", async () => {
  const { base, home, archive } = await fixture();
  try {
    const result = await copyClientSkills({
      hub: path.join(base, "missing"),
      home,
      archive,
      apply: true,
      auto: true,
    });
    assert.deepEqual(result, { actions: [], backup: null });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("pruneClientSkills removes copies of a skill that left the hub, unless edited", async () => {
  const { base, hub, home, archive } = await fixture();
  try {
    await copyClientSkills({ hub, home, archive, apply: true });
    const before = await hubSkillHashes(hub);
    await writeFile(
      path.join(home, ".codex", "skills", "alpha", "SKILL.md"),
      "alpha, my edit",
    );
    await rm(path.join(hub, "alpha"), { recursive: true });
    const removed = await pruneClientSkills(before, { hub, home });
    assert.deepEqual(removed, ["claude:alpha"]);
    assert.equal(
      await readFile(
        path.join(home, ".codex", "skills", "alpha", "SKILL.md"),
        "utf8",
      ),
      "alpha, my edit",
    );
    assert.ok(await lstat(path.join(home, ".claude", "skills", "beta")));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
