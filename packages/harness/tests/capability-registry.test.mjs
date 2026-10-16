import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { capabilityManifestSchema } from "@ocean/core/domain/capabilities/capability-manifest.js";
import {
  CapabilityCatalog,
  LocalIndexSource,
} from "@ocean/market/capability/catalog.js";
import {
  CapabilityRegistry,
  compareSemver,
} from "@ocean/market/capability/registry.js";

const manifest = (overrides = {}) => ({
  kind: "skill",
  name: "dev.ocean.skills.ship",
  version: "1.0.0",
  engines: { ocean: ">=0.3.0" },
  source: { type: "path", path: "skills/ship" },
  integrity: { sha256: "a".repeat(64) },
  spec: { entry: "SKILL.md" },
  ...overrides,
});

const adapter = (kind, parseSpec = (spec) => spec) => ({
  kind,
  parseSpec,
  install: async () => {},
  uninstall: async () => {},
});

test("accepts a valid manifest and defaults permissions to none", () => {
  const parsed = capabilityManifestSchema.parse(manifest());
  assert.deepEqual(parsed.permissions, {
    filesystem: { read: [], write: [] },
    network: [],
    env: [],
    exec: [],
  });
});

test("rejects a bad name, version, digest, escaping path and unknown field", () => {
  for (const bad of [
    manifest({ name: "ship" }),
    manifest({ version: "1.0" }),
    manifest({ integrity: { sha256: "A".repeat(64) } }),
    manifest({ source: { type: "path", path: "../outside" } }),
    manifest({ source: { type: "path", path: "/etc/passwd" } }),
    manifest({ source: { type: "path", path: "C:\\\\x" } }),
    manifest({ source: { type: "url", url: "http://example.com/x.tgz" } }),
    manifest({ permissions: { network: ["x"], sudo: true } }),
    { ...manifest(), extra: 1 },
  ])
    assert.equal(
      capabilityManifestSchema.safeParse(bad).success,
      false,
      JSON.stringify(bad),
    );
});

test("accepts an official MCP registry style name", () => {
  assert.equal(
    capabilityManifestSchema.safeParse(
      manifest({ kind: "mcp", name: "io.github.owner/server" }),
    ).success,
    true,
  );
});

test("dispatches by kind and validates the spec through the adapter", () => {
  const registry = new CapabilityRegistry();
  registry.register(
    adapter("skill", (spec) => {
      if (spec?.entry !== "SKILL.md") throw new Error("entry must be SKILL.md");
      return spec;
    }),
  );
  const resolved = registry.resolve(manifest());
  assert.equal(resolved.adapter.kind, "skill");
  assert.deepEqual(resolved.spec, { entry: "SKILL.md" });
  assert.throws(
    () => registry.resolve(manifest({ spec: {} })),
    /Invalid skill spec.*entry must be SKILL.md/,
  );
});

test("refuses an unknown kind and a duplicate adapter", () => {
  const registry = new CapabilityRegistry();
  registry.register(adapter("skill"));
  assert.throws(
    () => registry.register(adapter("skill")),
    /already registered/,
  );
  assert.throws(
    () => registry.resolve(manifest({ kind: "mcp" })),
    /No capability adapter for kind "mcp"/,
  );
});

test("a throwaway kind works by registering an adapter alone", () => {
  const registry = new CapabilityRegistry();
  registry.register(adapter("theme"));
  assert.equal(
    registry.resolve(manifest({ kind: "theme", spec: { colors: 3 } })).adapter
      .kind,
    "theme",
  );
});

test("orders versions by semver precedence", () => {
  const sorted = [
    "1.0.0",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-beta",
    "0.9.12",
    "1.10.0",
    "1.2.0",
  ].sort(compareSemver);
  assert.deepEqual(sorted, [
    "0.9.12",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-beta",
    "1.0.0",
    "1.2.0",
    "1.10.0",
  ]);
});

test("catalog merges sources and resolves the newest stable version", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-market-"));
  const index = (capabilities) =>
    JSON.stringify({ schemaVersion: 1, name: "local", capabilities });
  await writeFile(
    path.join(dir, "a.json"),
    index([
      manifest(),
      manifest({ version: "1.2.0" }),
      manifest({ version: "2.0.0-rc.1" }),
    ]),
  );
  await writeFile(
    path.join(dir, "b.json"),
    index([manifest({ version: "1.2.0", description: "shadowed" })]),
  );
  const catalog = new CapabilityCatalog([
    new LocalIndexSource(path.join(dir, "a.json")),
    new LocalIndexSource(path.join(dir, "b.json")),
  ]);
  assert.equal((await catalog.list()).length, 3);
  const newest = await catalog.find("dev.ocean.skills.ship");
  assert.equal(newest.manifest.version, "1.2.0");
  assert.equal(newest.manifest.description, undefined);
  assert.equal(newest.baseDir, dir);
  assert.equal(
    (await catalog.find("dev.ocean.skills.ship", "2.0.0-rc.1")).manifest
      .version,
    "2.0.0-rc.1",
  );
  assert.equal(await catalog.find("dev.ocean.missing"), undefined);
});

test("catalog reports an invalid index with the failing path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-market-"));
  await writeFile(
    path.join(dir, "bad.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "x",
      capabilities: [manifest({ version: "x" })],
    }),
  );
  await assert.rejects(
    new CapabilityCatalog([
      new LocalIndexSource(path.join(dir, "bad.json")),
    ]).list(),
    /Invalid marketplace index .*capabilities\.0\.version/,
  );
});
