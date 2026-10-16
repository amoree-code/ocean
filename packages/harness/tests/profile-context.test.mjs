import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildContextReferences,
  CONTEXT_REFERENCE_MAX_BYTES,
} from "@ocean/context/context/context-references.js";
import { validateContextManifest } from "@ocean/core/domain/context/context-validator.js";
import { selectProfileClient } from "@ocean/core/domain/profiles/profile.js";
import { executionPolicy } from "@ocean/core/domain/profiles/profile-policy.js";
import { validateProfile } from "@ocean/core/domain/profiles/profile-validator.js";
import { PROJECTS_DIR } from "@ocean/core/shared/paths.js";

test("validates a profile and bounds context to allowed files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-context-"));
  await writeFile(path.join(root, "allowed.md"), "allowed context");
  await writeFile(path.join(root, "private.md"), "private context");
  const profile = validateProfile({
    name: "reviewer",
    provider: "claude",
    model: "sonnet",
    role: "review only",
    allowedPaths: ["allowed.md"],
    contextSources: ["allowed.md", "private.md"],
  });
  const result = await buildContextReferences({
    profile,
    prompt: "Review",
    cwd: root,
  });
  assert.deepEqual(result.manifest.files, ["allowed.md"]);
  assert.deepEqual(result.manifest.omitted, ["private.md"]);
  assert.match(result.content, /allowed\.md/);
  assert.doesNotMatch(result.content, /private\.md/);
  assert.doesNotMatch(result.content, /allowed context/);
});

test("rejects a profile missing required fields", () => {
  assert.throws(() =>
    validateProfile({ provider: "claude", model: "sonnet", role: "assistant" }),
  );
});

test("rejects a profile with an unknown provider", () => {
  assert.throws(() =>
    validateProfile({
      name: "bad",
      provider: "chatgpt",
      model: "sonnet",
      role: "assistant",
    }),
  );
});

test("accepts Hermes as a profile provider", () => {
  assert.equal(
    validateProfile({
      name: "hermes",
      provider: "hermes",
      model: "provider-managed",
      role: "assistant",
    }).provider,
    "hermes",
  );
});

test("rejects a profile with an unknown write policy", () => {
  assert.throws(() =>
    validateProfile({
      name: "bad",
      provider: "claude",
      model: "sonnet",
      role: "assistant",
      writePolicy: "unrestricted",
    }),
  );
});

test("defaults skills, allowedPaths, allowedCommands, contextSources, and writePolicy", () => {
  const profile = validateProfile({
    name: "minimal",
    provider: "claude",
    model: "sonnet",
    role: "assistant",
  });
  assert.deepEqual(profile.skills, [
    "design-thinking",
    "business-logic",
    "core-thinking",
    "verification",
    "loop",
    "use-browser",
  ]);
  assert.deepEqual(profile.allowedPaths, []);
  assert.deepEqual(profile.allowedCommands, []);
  assert.deepEqual(profile.contextSources, []);
  assert.equal(profile.writePolicy, "none");
});

test("skips context sources outside every allowed path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-context-"));
  await writeFile(path.join(root, "secret.md"), "top secret");
  const profile = validateProfile({
    name: "reviewer",
    provider: "claude",
    model: "sonnet",
    role: "review only",
    allowedPaths: [],
    contextSources: ["secret.md"],
  });
  const result = await buildContextReferences({
    profile,
    prompt: "Review",
    cwd: root,
  });
  assert.deepEqual(result.manifest.files, []);
  assert.deepEqual(result.manifest.references, []);
  assert.equal(result.content, "");
});

test("validates a well-formed context manifest", () => {
  const manifest = validateContextManifest({
    files: ["allowed.md"],
    bytes: 16,
    compactedSummary: null,
    lastContextCheckpoint: new Date().toISOString(),
  });
  assert.equal(manifest.bytes, 16);
  assert.deepEqual(manifest.references, []);
});

test("accepts multiple enabled clients in one universal profile", () => {
  const profile = validateProfile({
    name: "developer",
    role: "developer",
    clients: {
      hermes: { enabled: true, profile: "developer" },
      codex: { enabled: true, model: "gpt-5" },
    },
  });
  assert.equal(profile.provider, "hermes");
  assert.equal(profile.clients.codex.model, "gpt-5");
});

test("rejects an unknown universal-profile client", () => {
  assert.throws(
    () =>
      validateProfile({
        name: "bad",
        role: "assistant",
        clients: { unknown: { enabled: true } },
      }),
    /Unsupported client/,
  );
});

test("selects an enabled client and rejects a disabled client", () => {
  const profile = validateProfile({
    name: "developer",
    role: "developer",
    clients: {
      hermes: { enabled: true, model: "provider-managed" },
      codex: { enabled: false, model: "gpt-5" },
    },
  });
  assert.equal(selectProfileClient(profile, "hermes").provider, "hermes");
  assert.throws(() => selectProfileClient(profile, "codex"), /not enabled/);
});

test("rejects a context manifest with negative bytes", () => {
  assert.throws(() =>
    validateContextManifest({
      files: [],
      bytes: -1,
      compactedSummary: null,
      lastContextCheckpoint: new Date().toISOString(),
    }),
  );
});

test("rejects a context manifest with an empty checkpoint", () => {
  assert.throws(() =>
    validateContextManifest({
      files: [],
      bytes: 0,
      compactedSummary: null,
      lastContextCheckpoint: "",
    }),
  );
});

test("rejects a context manifest missing required fields", () => {
  assert.throws(() => validateContextManifest({ files: [], bytes: 0 }));
});

test("enforces an explicit provider command allowlist", () => {
  const profile = validateProfile({
    name: "reviewer",
    provider: "claude",
    model: "sonnet",
    role: "reviewer",
    allowedCommands: ["codex"],
  });
  assert.throws(
    () => executionPolicy(profile, "/tmp/project"),
    /Policy denied provider command/,
  );
});

test("accepts an allowed provider and rejects empty allowed-paths policy", () => {
  const profile = validateProfile({
    name: "developer",
    provider: "claude",
    model: "sonnet",
    role: "developer",
    allowedCommands: ["claude"],
    writePolicy: "workspace",
  });
  assert.equal(
    executionPolicy(profile, "/tmp/project").providerCommand,
    "claude",
  );
  const restricted = validateProfile({
    ...profile,
    writePolicy: "allowed-paths",
    allowedPaths: [],
  });
  assert.throws(
    () => executionPolicy(restricted, "/tmp/project"),
    /without allowed paths/,
  );
});

test("headless context starts with the project's rules, and references fit what is left", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-rules-"));
  const taskDir = path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-1");
  await mkdir(taskDir, { recursive: true });
  await writeFile(path.join(taskDir, "task.md"), "task body");
  const rules = Array.from(
    { length: 10 },
    (_, i) => `rule ${i} ${"x".repeat(190)}`,
  );
  await writeFile(
    path.join(root, PROJECTS_DIR, "ocean", "project.json"),
    JSON.stringify({ name: "ocean", paths: [], rules }),
  );
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    const profile = validateProfile({
      name: "worker",
      provider: "claude",
      model: "sonnet",
      role: "work",
      allowedPaths: [root],
    });
    const result = await buildContextReferences({
      profile,
      prompt: "show T-1",
      cwd: root,
    });
    assert.ok(result.content.startsWith("## Project rules (ocean)\n- rule 0"));
    assert.match(result.content, /\n\n## Context references\n/);
    assert.match(result.content, /T-1[\\/]task\.md/);
    assert.ok(Buffer.byteLength(result.content) <= CONTEXT_REFERENCE_MAX_BYTES);
    assert.equal(result.manifest.bytes, Buffer.byteLength(result.content));
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});

test("a bound project's rules reach every headless run, whatever the prompt or memory setting; unreadable rules refuse", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-rules-any-"));
  await mkdir(path.join(root, PROJECTS_DIR, "ocean"), { recursive: true });
  const manifest = path.join(root, PROJECTS_DIR, "ocean", "project.json");
  await writeFile(
    manifest,
    JSON.stringify({ name: "ocean", paths: [], rules: ["no prod writes"] }),
  );
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    const profile = validateProfile({
      name: "worker",
      provider: "claude",
      model: "sonnet",
      role: "work",
      allowedPaths: [root],
      memory: { enabled: false },
    });
    const result = await buildContextReferences({
      profile,
      prompt: "refactor the parser",
      cwd: root,
    });
    assert.ok(
      result.content.startsWith("## Project rules (ocean)\n- no prod writes"),
    );
    await writeFile(manifest, JSON.stringify({ paths: [], rules: "bare" }));
    await assert.rejects(
      buildContextReferences({ profile, prompt: "refactor", cwd: root }),
      /Project rules \(ocean\) unreadable: rules must be a list/,
    );
    const outside = await mkdtemp(path.join(os.tmpdir(), "ocean-unbound-"));
    const unbound = await buildContextReferences({
      profile: { ...profile, allowedPaths: [outside] },
      prompt: "refactor",
      cwd: outside,
    });
    assert.equal(unbound.content, "");
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});
