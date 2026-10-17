import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { marketplaceIndexSchema } from "@ocean/core/domain/capabilities/capability-manifest.js";
import { createMcpAdapter } from "@ocean/market/adapters/mcp-adapter.js";
import { createSkillAdapter } from "@ocean/market/adapters/skill-adapter.js";
import {
  CapabilityCatalog,
  LocalIndexSource,
} from "@ocean/market/capability/catalog.js";
import { contentDigest } from "@ocean/market/capability/content-digest.js";
import { CapabilityRegistry } from "@ocean/market/capability/registry.js";
import { MarketplaceService } from "@ocean/market/install/marketplace-service.js";
import {
  mcpClientConfig,
  oceanMcpConfig,
} from "@ocean/market/mcp/mcp-connection.js";
import { scanText } from "@ocean/market/security/description-scan.js";
import { McpToolRegistry } from "@ocean/services/infrastructure/mcp/tool-registry.js";

const engineIndex = path.resolve("ocean-marketplace.json");
const coreSkills = path.resolve("skills", "core");

const service = (root, registry) =>
  new MarketplaceService({
    registry,
    catalog: new CapabilityCatalog([new LocalIndexSource(engineIndex)]),
    storeDir: path.join(root, "store"),
    lockFile: path.join(root, "ocean.lock"),
    consent: async () => true,
  });

test("the engine index is generated from the current files", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/generate-marketplace-index.mjs", "--check"],
    {
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
});

// The generator carries its own copy of the digest so it can run before the build; this pins the
// two together: every digest in the index must equal the market's contentDigest of its payload.
test("the engine index is schema-valid and every digest matches contentDigest", async () => {
  const index = marketplaceIndexSchema.parse(
    JSON.parse(await readFile(engineIndex, "utf8")),
  );
  assert.equal(index.capabilities.length, 12);
  for (const capability of index.capabilities)
    assert.equal(
      await contentDigest(path.resolve(capability.source.path)),
      capability.integrity.sha256,
      capability.name,
    );
});

test("every core skill is in the engine index and passes the injection scan", async () => {
  const index = JSON.parse(await readFile(engineIndex, "utf8"));
  const names = (await readdir(coreSkills, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.equal(names.length, 9);
  for (const name of names) {
    assert.ok(
      index.capabilities.some(
        (entry) => entry.name === `dev.ocean.skills.${name}`,
      ),
      name,
    );
    for (const file of await readdir(path.join(coreSkills, name), {
      recursive: true,
    }))
      if (file.endsWith(".md"))
        assert.deepEqual(
          scanText(
            file,
            await readFile(path.join(coreSkills, name, file), "utf8"),
          ),
          [],
          `${name}/${file}`,
        );
  }
});

test("a core skill and an engine MCP server install from the engine index with verified digests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-engine-"));
  const registry = new CapabilityRegistry();
  registry.register(createSkillAdapter(() => path.join(root, "hub")));
  registry.register(createMcpAdapter(() => path.join(root, "mcp")));
  const market = service(root, registry);
  assert.equal(
    (await market.install("dev.ocean.skills.verification")).status,
    "installed",
  );
  assert.ok(
    (await stat(path.join(root, "hub", "verification", "SKILL.md"))).isFile(),
  );
  assert.equal((await market.install("dev.ocean/ocean")).status, "installed");
  assert.ok(
    (await stat(path.join(root, "mcp", "dev.ocean__ocean.json"))).isFile(),
  );
});

test("a throwaway kind installs through the unchanged service with one registered adapter", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-kind-"));
  const installed = [];
  const registry = new CapabilityRegistry();
  // The engine index has no `theme`; a skill entry is re-kinded through a test catalog source.
  registry.register({
    kind: "theme",
    parseSpec: (spec) => spec,
    install: async ({ manifest, contentDir }) => {
      installed.push([
        manifest.name,
        (await stat(path.join(contentDir, "SKILL.md"))).isFile(),
      ]);
    },
    uninstall: async ({ manifest }) => {
      installed.push([manifest.name, "removed"]);
    },
  });
  const source = new LocalIndexSource(engineIndex);
  const themed = {
    id: "test:themes",
    list: async () =>
      (await source.list())
        .filter((entry) => entry.manifest.name === "dev.ocean.skills.loop")
        .map((entry) => ({
          ...entry,
          manifest: {
            ...entry.manifest,
            kind: "theme",
            name: "dev.example.themes.dark",
          },
        })),
  };
  const market = new MarketplaceService({
    registry,
    catalog: new CapabilityCatalog([themed]),
    storeDir: path.join(root, "store"),
    lockFile: path.join(root, "ocean.lock"),
    consent: async () => true,
  });
  await market.install("dev.example.themes.dark");
  await market.uninstall("dev.example.themes.dark");
  assert.deepEqual(installed, [
    ["dev.example.themes.dark", true],
    ["dev.example.themes.dark", "removed"],
  ]);
});

test("client MCP configs come from the engine index", () => {
  const ocean = oceanMcpConfig().mcpServers.ocean;
  assert.deepEqual(ocean.args.slice(-2), ["mcp", "serve"]);
  assert.equal(ocean.command, process.execPath);
  assert.throws(
    () => mcpClientConfig("dev.ocean/missing"),
    /not an MCP capability in the engine index/,
  );
});

test("the MCP tool registry validates, refuses duplicates and keeps order", () => {
  const registry = new McpToolRegistry([
    { name: "a", description: "first" },
    { name: "b", description: "second" },
  ]);
  assert.deepEqual(
    registry.list().map((tool) => tool.name),
    ["a", "b"],
  );
  assert.equal(registry.has("a"), true);
  assert.equal(registry.has("c"), false);
  assert.throws(() => registry.register({ name: "a" }), /already registered/);
  assert.throws(() => registry.register({ name: "" }), /Invalid MCP tool/);
});
