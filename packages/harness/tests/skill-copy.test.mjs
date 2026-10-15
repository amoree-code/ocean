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
import { copyClientSkills } from "../dist/application/skills/skill-hub.js";

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
