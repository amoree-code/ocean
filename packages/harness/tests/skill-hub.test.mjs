import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  linkClientSkills,
  populateSkillHub,
} from "../dist/application/skills/skill-hub.js";

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "ocean-hub-"));
  process.env.OCEAN_ROOT = path.join(base, "root");
  const home = path.join(base, "home");
  const extra = path.join(base, "extra");
  await mkdir(path.join(extra, "mine"), { recursive: true });
  await writeFile(path.join(extra, "mine", "SKILL.md"), "mine");
  const client = path.join(home, ".codex", "skills");
  await mkdir(path.join(client, "mine"), { recursive: true });
  await writeFile(path.join(client, "mine", "SKILL.md"), "old copy");
  return { home, extra, client, base };
}

test("hub is additive and link is a dry run until --apply", async () => {
  const { home, extra, client } = await fixture();
  const first = await populateSkillHub([extra]);
  assert.ok(first.added.includes("mine"));
  assert.ok(first.added.includes("graft"));
  const again = await populateSkillHub([extra]);
  assert.deepEqual(again.added, []);

  const plan = await linkClientSkills({ home });
  assert.equal(plan.actions.find((a) => a.skill === "graft").action, "skip");
  assert.equal(plan.backup, null);
  assert.equal(plan.actions.find((a) => a.skill === "mine").action, "replace");
  assert.equal(
    (await lstat(path.join(client, "mine"))).isSymbolicLink(),
    false,
  );

  const applied = await linkClientSkills({ home, apply: true });
  assert.ok(applied.backup);
  const link = path.join(client, "mine");
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.match(await readlink(link), /skills[\\/]mine$/);
  assert.deepEqual(await readdir(path.join(applied.backup, "codex")), ["mine"]);

  const rerun = await linkClientSkills({ home, apply: true });
  assert.ok(
    rerun.actions.every((a) => a.action === "linked" || a.action === "skip"),
  );
  assert.equal(rerun.backup, null);
});
