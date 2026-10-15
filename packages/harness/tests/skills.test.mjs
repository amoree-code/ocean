import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addSkillCandidate,
  learnSkillFromSession,
  listSkillCandidates,
  loadPromotedSkills,
  reviewSkillCandidate,
} from "../dist/application/skills/skill-curation.js";
import { defaultSessionStoreFactory } from "../dist/composition/runtime.js";
import {
  listSkills,
  loadSkill,
  loadSkillIndex,
} from "../dist/infrastructure/filesystem/skill-loader.js";
import { openSessionStore } from "../dist/infrastructure/persistence/session-store.js";
import { PROJECTS_DIR, SYSTEM_DIR } from "../dist/paths.js";

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

test("promoted skills are truncated by bytes with a marker naming the candidate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-promoted-bytes-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await addSkillCandidate({
      id: "arabic-review",
      name: "Arabic Review",
      instructions: "مرحبا بالعالم ".repeat(400),
    });
    await reviewSkillCandidate("arabic-review", "promoted");
    const [skill] = await loadPromotedSkills("apply arabic review", 1000);
    assert.equal(skill.truncated, true);
    assert.ok(Buffer.byteLength(skill.instructions) <= 1000);
    // The marker is an actionable pointer: the entry id, the command and the store file.
    assert.match(skill.instructions, /entry id "arabic-review"/);
    assert.match(skill.instructions, /`ocean skill list`/);
    assert.ok(
      skill.instructions.includes(
        path.join(root, SYSTEM_DIR, "skills", "candidates.json"),
      ),
    );
    assert.equal(
      Buffer.from(skill.instructions, "utf8").toString("utf8"),
      skill.instructions,
    );
    assert.ok(!skill.instructions.includes("\uFFFD"));
    const [whole] = await loadPromotedSkills("apply arabic review");
    assert.equal(whole.truncated, false);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});

test("auto-activates only owner-reviewed promoted skills matching the prompt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-auto-skills-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await addSkillCandidate({
      id: "typescript-review",
      name: "TypeScript Review",
      instructions: "Check strict typing.",
    });
    await addSkillCandidate({
      id: "untrusted-review",
      name: "Untrusted Review",
      instructions: "Do not load me.",
    });
    await reviewSkillCandidate("typescript-review", "promoted");
    const loaded = await loadPromotedSkills(
      "Please apply TypeScript Review to this change",
    );
    assert.deepEqual(
      loaded.map((skill) => skill.id),
      ["typescript-review"],
    );
    assert.deepEqual(
      await loadPromotedSkills("Please apply Untrusted Review"),
      [],
    );
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
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

test("stores and requires review for skill candidates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-skill-candidates-"));
  process.env.OCEAN_ROOT = root;
  await addSkillCandidate({
    id: "review",
    name: "Review",
    instructions: "Check the diff.",
  });
  assert.equal((await listSkillCandidates())[0].status, "candidate");
  assert.equal(
    (await reviewSkillCandidate("review", "promoted")).status,
    "promoted",
  );
  delete process.env.OCEAN_ROOT;
});

test("learns a bounded skill candidate from a completed session without auto-promoting it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-skill-learning-"));
  process.env.OCEAN_ROOT = root;
  const sessionId = "learn-session";
  const store = await openSessionStore();
  store.create({
    sessionId,
    provider: "codex",
    providerSessionId: null,
    parentSessionId: null,
    profile: "default",
    profileIdentity: "",
    workingDirectory: root,
    resumeData: null,
  });
  store.updateStatus(sessionId, "running");
  store.appendEvent(
    sessionId,
    "provider_output",
    "Use a bounded review checklist.",
  );
  store.appendEvent(
    sessionId,
    "evidence",
    JSON.stringify({ result: "proven" }),
  );
  store.updateStatus(sessionId, "completed");
  store.close();
  const candidate = await learnSkillFromSession(
    sessionId,
    defaultSessionStoreFactory,
  );
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.sourceSessionId, sessionId);
  assert.match(candidate.instructions, /bounded review/);
  delete process.env.OCEAN_ROOT;
});
