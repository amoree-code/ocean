import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadProfileDistribution } from "../dist/application/profiles/profile-distribution.js";
import { loadProfile } from "../dist/infrastructure/filesystem/profile-loader.js";
import { openSessionStore } from "../dist/infrastructure/persistence/session-store.js";
import { SYSTEM_DIR } from "../dist/paths.js";

test("loadProfile reads profiles from private OCEAN_ROOT/system/profiles, not the engine tree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-profile-loader-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "reviewer.json"),
    JSON.stringify({
      name: "reviewer",
      provider: "claude",
      model: "sonnet",
      role: "review only",
    }),
  );

  process.env.OCEAN_ROOT = root;
  try {
    const profile = await loadProfile("reviewer");
    assert.equal(profile.name, "reviewer");
    assert.equal(profile.provider, "claude");
  } finally {
    delete process.env.OCEAN_ROOT;
  }
});

test("loadProfile rejects a name whose file does not exist under OCEAN_ROOT", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ocean-profile-loader-missing-"),
  );
  process.env.OCEAN_ROOT = root;
  try {
    await assert.rejects(loadProfile("missing"));
  } finally {
    delete process.env.OCEAN_ROOT;
  }
});

test("loadProfile rejects traversal names before reading outside the profiles root", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ocean-profile-loader-traversal-"),
  );
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await writeFile(
    path.join(root, "outside.json"),
    JSON.stringify({
      name: "outside",
      provider: "claude",
      model: "sonnet",
      role: "outside",
    }),
  );
  process.env.OCEAN_ROOT = root;
  try {
    await assert.rejects(loadProfile("../outside"), /Invalid profile name/);
  } finally {
    delete process.env.OCEAN_ROOT;
  }
});

test("loadProfile keeps legacy profile directories compatible during migration", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ocean-profile-directory-"),
  );
  const directory = path.join(root, SYSTEM_DIR, "profiles", "developer");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "profile.json"),
    JSON.stringify({
      name: "developer",
      role: "developer",
      clients: { hermes: { enabled: true, profile: "developer" } },
      governance: { writePolicy: "workspace", allowedPaths: ["."] },
    }),
  );
  await writeFile(
    path.join(directory, "instructions.md"),
    "Inspect before editing.",
  );

  process.env.OCEAN_ROOT = root;
  try {
    const profile = await loadProfile("developer");
    assert.equal(profile.provider, "hermes");
    assert.equal(profile.defaultClient, "hermes");
    assert.equal(profile.writePolicy, "workspace");
    assert.equal(profile.instructions, "Inspect before editing.");
  } finally {
    delete process.env.OCEAN_ROOT;
  }
});

test("all practical role profiles use the universal client contract", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ocean-profile-loader-universal-"),
  );
  const profilesDirectory = path.join(root, SYSTEM_DIR, "profiles");
  await mkdir(profilesDirectory, { recursive: true });
  const template = JSON.parse(
    await readFile(
      new URL("../templates/profiles/default.json", import.meta.url),
      "utf8",
    ),
  );
  const names = [
    "default",
    "developer",
    "reviewer",
    "strategist",
    "tester",
    "security-auditor",
    "devops",
    "researcher",
  ];
  for (const name of names)
    await writeFile(
      path.join(profilesDirectory, `${name}.json`),
      JSON.stringify({ ...template, name }),
    );

  process.env.OCEAN_ROOT = root;
  try {
    for (const name of names) {
      const profile = await loadProfile(name);
      assert.equal(profile.name, name);
      assert.deepEqual(Object.keys(profile.clients).sort(), [
        "antigravity",
        "claude",
        "codex",
        "gemini",
        "hermes",
      ]);
      assert.equal(profile.defaultClient, "claude");
      assert.equal(profile.clients.claude.enabled, true);
      assert.ok(profile.instructions.length > 0);
    }
  } finally {
    delete process.env.OCEAN_ROOT;
  }
});

test("a profile distribution reads oceanRequires, defaulting to any version", async () => {
  const { validateProfileDistribution } = await import(
    "@ocean/core/domain/profiles/profile-distribution.js"
  );
  const base = { name: "p", version: "1.0.0" };
  assert.equal(validateProfileDistribution(base).oceanRequires, "*");
  assert.equal(
    validateProfileDistribution({ ...base, oceanRequires: ">=0.4" })
      .oceanRequires,
    ">=0.4",
  );
});

test("validates a profile distribution and rejects private state", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ocean-profile-distribution-"),
  );
  await writeFile(
    path.join(root, "distribution.yaml"),
    JSON.stringify({
      name: "developer",
      version: "1.0.0",
      files: ["profile.json", "instructions.md"],
    }),
  );
  await writeFile(path.join(root, "profile.json"), "{}");
  await writeFile(path.join(root, "instructions.md"), "instructions");
  assert.equal((await loadProfileDistribution(root)).name, "developer");

  const unsafe = await mkdtemp(
    path.join(os.tmpdir(), "ocean-profile-distribution-unsafe-"),
  );
  await writeFile(
    path.join(unsafe, "distribution.yaml"),
    JSON.stringify({ name: "unsafe", version: "1.0.0", files: [".env"] }),
  );
  await assert.rejects(
    loadProfileDistribution(unsafe),
    /forbidden private state/,
  );

  const traversal = await mkdtemp(
    path.join(os.tmpdir(), "ocean-profile-distribution-traversal-"),
  );
  await writeFile(
    path.join(traversal, "distribution.yaml"),
    JSON.stringify({ name: "unsafe", version: "1.0.0", files: ["../outside"] }),
  );
  await assert.rejects(
    loadProfileDistribution(traversal),
    /escapes package root/,
  );
});

test("openSessionStore persists sessions under OCEAN_ROOT/system/sessions/sessions.sqlite", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-session-persist-"));
  process.env.OCEAN_ROOT = root;
  try {
    const store = await openSessionStore();
    store.create({
      sessionId: "persisted-1",
      provider: "claude",
      providerSessionId: null,
      parentSessionId: null,
      profile: "default",
      workingDirectory: root,
      resumeData: null,
    });
    store.close();

    const reopened = await openSessionStore();
    assert.equal(reopened.get("persisted-1").sessionId, "persisted-1");
    reopened.close();
  } finally {
    delete process.env.OCEAN_ROOT;
  }
});
