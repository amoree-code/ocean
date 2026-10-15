import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateProfile } from "@ocean/core/domain/profiles/profile-validator.js";
import {
  buildContextReferences,
  resolveContextSources,
} from "../dist/application/context/context-references.js";
import { BRAIN_RECORD_DIRS, PROJECTS_DIR, SYSTEM_DIR } from "../dist/paths.js";

test("context returns a compact JSON packet without loading task bodies", async () => {
  const result = spawnSync(
    process.execPath,
    [path.resolve("dist/main.js"), "context", "--json"],
    // Run from inside the workspace root, where the workspace project resolves.
    { cwd: process.env.OCEAN_ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const packet = JSON.parse(result.stdout);
  const { version } = JSON.parse(
    await readFile(path.resolve("package.json"), "utf8"),
  );
  assert.equal(packet.project, "ocean");
  assert.equal(packet.version, version);
  assert.deepEqual(packet.roots, [
    ...BRAIN_RECORD_DIRS,
    PROJECTS_DIR,
    SYSTEM_DIR,
  ]);
  assert.ok(Array.isArray(packet.tasks));
});

test("context rejects symlinks that escape allowed paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-context-link-"));
  const outside = await mkdtemp(
    path.join(os.tmpdir(), "ocean-context-outside-"),
  );
  await mkdir(path.join(root, "allowed"));
  await writeFile(path.join(outside, "secret.md"), "outside secret");
  await symlink(
    path.join(outside, "secret.md"),
    path.join(root, "allowed", "linked.md"),
  );
  const profile = validateProfile({
    name: "reader",
    provider: "claude",
    role: "reader",
    allowedPaths: ["allowed"],
    contextSources: ["allowed/linked.md"],
  });
  const resolved = await resolveContextSources(profile, root);
  assert.deepEqual(resolved.references, []);
  assert.deepEqual(resolved.omitted, ["allowed/linked.md"]);
  const context = await buildContextReferences({
    profile,
    prompt: "Review",
    cwd: root,
  });
  assert.equal(context.content, "");
  assert.deepEqual(context.manifest.omitted, ["allowed/linked.md"]);
  assert.deepEqual(context.manifest.references, []);
});

test("context sources are referenced, never read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-context-ref-"));
  const rel = "notes.md";
  await writeFile(path.join(root, rel), "UNIQUE-BODY-MARKER مرحبا");
  const profile = validateProfile({
    name: "reader",
    provider: "claude",
    role: "reader",
    allowedPaths: [rel],
    contextSources: [rel],
  });
  const context = await buildContextReferences({
    profile,
    prompt: "Review",
    cwd: root,
  });
  assert.ok(context.content.includes(rel));
  assert.ok(!context.content.includes("UNIQUE-BODY-MARKER"));
  assert.deepEqual(context.manifest.files, [rel]);
  assert.equal(context.manifest.bytes, Buffer.byteLength(context.content));
  assert.equal(context.manifest.compression, null);
  assert.equal(context.manifest.references[0].path, rel);
  assert.equal(context.manifest.references[0].base, "cwd");
  assert.equal(context.manifest.references[0].recordType, "context-source");
  assert.equal(
    context.manifest.references[0].bytes,
    Buffer.byteLength("UNIQUE-BODY-MARKER مرحبا"),
  );
});
