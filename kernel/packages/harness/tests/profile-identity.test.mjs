import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { profileIdentity } from "@ocean/core/domain/profiles/profile.js";
import { validateProfile } from "@ocean/core/domain/profiles/profile-validator.js";
import { SessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";

test("defaults description to empty string and version to 1.0.0", () => {
  const profile = validateProfile({
    name: "minimal",
    provider: "claude",
    model: "sonnet",
    role: "assistant",
  });
  assert.equal(profile.description, "");
  assert.equal(profile.version, "1.0.0");
});

test("accepts an explicit description and version", () => {
  const profile = validateProfile({
    name: "reviewer",
    description: "review only",
    version: "2.1.0",
    provider: "claude",
    model: "sonnet",
    role: "code reviewer",
  });
  assert.equal(profile.description, "review only");
  assert.equal(profile.version, "2.1.0");
});

test("rejects an empty version string", () => {
  assert.throws(() =>
    validateProfile({
      name: "bad",
      version: "",
      provider: "claude",
      model: "sonnet",
      role: "assistant",
    }),
  );
});

test("profileIdentity is deterministic for identical profile content", () => {
  const a = validateProfile({
    name: "developer",
    version: "1.0.0",
    provider: "claude",
    model: "sonnet",
    role: "developer",
  });
  const b = validateProfile({
    name: "developer",
    version: "1.0.0",
    provider: "claude",
    model: "sonnet",
    role: "developer",
  });
  assert.equal(profileIdentity(a), profileIdentity(b));
});

test("profileIdentity changes when the profile version changes", () => {
  const v1 = validateProfile({
    name: "developer",
    version: "1.0.0",
    provider: "claude",
    model: "sonnet",
    role: "developer",
  });
  const v2 = validateProfile({
    name: "developer",
    version: "1.1.0",
    provider: "claude",
    model: "sonnet",
    role: "developer",
  });
  assert.notEqual(profileIdentity(v1), profileIdentity(v2));
});

test("profileIdentity changes when any policy field changes", () => {
  const readOnly = validateProfile({
    name: "reviewer",
    provider: "claude",
    model: "sonnet",
    role: "reviewer",
    writePolicy: "none",
  });
  const writable = validateProfile({
    name: "reviewer",
    provider: "claude",
    model: "sonnet",
    role: "reviewer",
    writePolicy: "workspace",
  });
  assert.notEqual(profileIdentity(readOnly), profileIdentity(writable));
});

test("a session created from a profile records that profile's deterministic identity", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "ocean-profile-identity-"),
  );
  const store = new SessionStore(path.join(directory, "sessions.sqlite"));
  const profile = validateProfile({
    name: "strategist",
    version: "1.0.0",
    provider: "claude",
    model: "sonnet",
    role: "strategist",
  });
  const identity = profileIdentity(profile);

  store.create({
    sessionId: "session-1",
    provider: profile.provider,
    providerSessionId: null,
    parentSessionId: null,
    profile: profile.name,
    profileIdentity: identity,
    workingDirectory: directory,
    resumeData: null,
  });

  assert.equal(store.get("session-1").profileIdentity, identity);
  store.close();
});

test("a session created without a profile identity defaults to an empty string, preserving older callers", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "ocean-profile-identity-legacy-"),
  );
  const store = new SessionStore(path.join(directory, "sessions.sqlite"));

  store.create({
    sessionId: "session-legacy",
    provider: "claude",
    providerSessionId: null,
    parentSessionId: null,
    profile: "default",
    workingDirectory: directory,
    resumeData: null,
  });

  assert.equal(store.get("session-legacy").profileIdentity, "");
  store.close();
});
