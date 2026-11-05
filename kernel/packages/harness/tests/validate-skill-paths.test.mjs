import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "validate-skill-paths.mjs",
);

// Builds a throwaway HOME with a workspace and one skill, runs the checker over it.
async function check(files, { existing = [] } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-paths-"));
  await mkdir(path.join(home, "ocean"), { recursive: true });
  for (const entry of existing) {
    const target = path.join(home, entry);
    if (entry.endsWith("/")) await mkdir(target, { recursive: true });
    else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "");
    }
  }
  const skills = path.join(home, "skills");
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(skills, "demo", name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  }
  const result = spawnSync(process.execPath, [script, skills], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf8",
  });
  return { status: result.status, out: result.stdout + result.stderr };
}

test("passes when every named path is there", async () => {
  const { status } = await check(
    { "SKILL.md": "Run `~/tools/run.sh` first.\n" },
    { existing: ["tools/run.sh"] },
  );
  assert.equal(status, 0);
});

test("fails on a dead path in SKILL.md", async () => {
  const { status, out } = await check({
    "SKILL.md": "Run `~/gone/run.sh` first.\n",
  });
  assert.equal(status, 1);
  assert.match(out, /gone\/run\.sh/);
});

test("scans references/*.md, not only SKILL.md", async () => {
  const { status, out } = await check({
    "SKILL.md": "No paths here.\n",
    "references/more.md": "```bash\n~/gone/run.sh --flag\n```\n",
  });
  assert.equal(status, 1);
  assert.match(out, /references[\\/]more\.md/);
});

test("a backslash-continued command does not capture the backslash", async () => {
  const { status, out } = await check({
    "SKILL.md": "```bash\n~/gone/run.sh\\\n  --flag\n```\n",
  });
  assert.equal(status, 1);
  assert.match(out, /gone\/run\.sh —/);
  assert.doesNotMatch(out, /run\.sh\\/);
});

test("a backticked command with arguments is still checked", async () => {
  const { status, out } = await check(
    { "SKILL.md": "Install: `~/venv/bin/tool install x`\n" },
    { existing: ["venv/"] },
  );
  assert.equal(status, 1);
  assert.match(out, /venv\/bin\/tool/);
});

test("a trailing-slash path must exist as a directory", async () => {
  const missing = await check(
    { "SKILL.md": "Lives in `~/parent/leaf/`.\n" },
    {
      existing: ["parent/"],
    },
  );
  assert.equal(missing.status, 1);
  const present = await check(
    { "SKILL.md": "Lives in `~/parent/leaf/`.\n" },
    {
      existing: ["parent/leaf/"],
    },
  );
  assert.equal(present.status, 0);
});

test("a file the skill creates on first use is not flagged", async () => {
  const { status } = await check(
    { "SKILL.md": "State goes in `~/.state/loop.md`.\n" },
    { existing: [".state/"] },
  );
  assert.equal(status, 0);
});

test("named optional installs are tolerated, anything else is not", async () => {
  const ok = await check({
    "SKILL.md": "`~/.browser-use-env/bin/playwright install chromium`\n",
  });
  assert.equal(ok.status, 0);
  const bad = await check({
    "SKILL.md": "`~/.browser-use-env/bin/other install chromium`\n",
  });
  assert.equal(bad.status, 1);
});
