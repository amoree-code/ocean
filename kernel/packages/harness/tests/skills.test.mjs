import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PROJECTS_DIR } from "@ocean/core/shared/paths.js";
import {
  listSkills,
  loadSkill,
  loadSkillIndex,
} from "../dist/infrastructure/filesystem/skill-loader.js";

test("lists the public core skill catalog without loading full instructions", async () => {
  const skills = await listSkills();
  assert.deepEqual(skills.map((skill) => skill.name).sort(), [
    "business-logic",
    "catch-up",
    "core-thinking",
    "design-thinking",
    "graft",
    "loop",
    "session-handoff",
    "use-browser",
    "verification",
  ]);
  assert.equal(Object.hasOwn(skills[0], "instructions"), false);
});

test("loads and validates a core skill on demand", async () => {
  const skill = await loadSkill("core-thinking");
  assert.equal(skill.category, "core");
  assert.match(skill.instructions, /Core Thinking/);
});

test("rejects unknown skills", async () => {
  await assert.rejects(() => loadSkill("missing-skill"), /Skill not found/);
});

test("indexes profile skills in order, ignores duplicates, and reads no bodies", async () => {
  const entries = await loadSkillIndex([
    "verification",
    "verification",
    "core-thinking",
  ]);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["verification", "core-thinking"],
  );
  for (const entry of entries) {
    assert.ok(entry.path.endsWith(path.join("core", entry.name, "SKILL.md")));
    assert.equal(Object.hasOwn(entry, "instructions"), false);
    assert.ok(entry.description.length > 0);
  }
});

test("the skill index rejects unknown skills", async () => {
  await assert.rejects(
    () => loadSkillIndex(["missing-skill"]),
    /Skill not found/,
  );
});

test("resolves private and project skills without reading them from engine", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-private-skills-"));
  const projectSkills = path.join(root, PROJECTS_DIR, "demo", "skills");
  await mkdir(path.join(projectSkills, "project", "project-only"), {
    recursive: true,
  });
  await writeFile(
    path.join(projectSkills, "index.json"),
    JSON.stringify([
      {
        name: "project-only",
        description: "Project skill",
        version: "1.0.0",
        category: "project",
      },
    ]),
  );
  await writeFile(
    path.join(projectSkills, "project", "project-only", "SKILL.md"),
    "Project instructions",
  );
  process.env.OCEAN_ROOT = root;
  const entries = await loadSkillIndex(
    ["project-only"],
    path.join(root, PROJECTS_DIR, "demo"),
  );
  assert.equal(
    entries[0].path,
    path.join(projectSkills, "project", "project-only", "SKILL.md"),
  );
  assert.equal(entries[0].description, "Project skill");
  delete process.env.OCEAN_ROOT;
});

test("the pinned local validator rejects malformed Agent Skills", async () => {
  const script = path.join(process.cwd(), "scripts", "validate-skills.mjs");
  const fixture = path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "skills",
    "malformed",
  );
  const child = spawn(process.execPath, [script, fixture], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = await new Promise((resolve) => {
    let value = "";
    child.stderr.on("data", (chunk) => {
      value += chunk;
    });
    child.on("close", (code) => resolve({ code, value }));
  });
  assert.notEqual(output.code, 0);
  assert.match(output.value, /invalid name/);
});
