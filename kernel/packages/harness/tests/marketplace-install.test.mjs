import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMcpAdapter } from "@ocean/market/adapters/mcp-adapter.js";
import { createPluginAdapter } from "@ocean/market/adapters/plugin-adapter.js";
import { createSkillAdapter } from "@ocean/market/adapters/skill-adapter.js";
import {
  CapabilityCatalog,
  LocalIndexSource,
} from "@ocean/market/capability/catalog.js";
import { contentDigest } from "@ocean/market/capability/content-digest.js";
import { CapabilityRegistry } from "@ocean/market/capability/registry.js";
import { MarketplaceService } from "@ocean/market/install/marketplace-service.js";

const cli = path.resolve("dist/main.js");
const exists = (file) =>
  stat(file).then(
    () => true,
    () => false,
  );

async function writeTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
}

// A temp marketplace: payload folders next to an index whose digests are computed from them.
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-market-"));
  const index = path.join(root, "index");
  await writeTree(index, {
    "skills/ship-1/SKILL.md": "---\nname: ship\n---\nv1\n",
    "skills/ship-2/SKILL.md": "---\nname: ship\n---\nv2\n",
    "mcp/files/README.md": "files server\n",
    "plugins/lint/.claude-plugin/plugin.json": '{"name":"lint"}\n',
  });
  const manifest = async (overrides) => {
    const base = {
      engines: { ocean: ">=0.3.0" },
      ...overrides,
    };
    base.integrity ??= {
      sha256: await contentDigest(path.join(index, base.source.path)),
    };
    return base;
  };
  const capabilities = [
    await manifest({
      kind: "skill",
      name: "dev.ocean.skills.ship",
      version: "1.0.0",
      source: { type: "path", path: "skills/ship-1" },
      spec: { directory: "ship" },
    }),
    await manifest({
      kind: "mcp",
      name: "io.github.example/files",
      version: "0.1.0",
      source: { type: "path", path: "mcp/files" },
      permissions: { filesystem: { read: ["~/notes"] } },
      spec: {
        name: "io.github.example/files",
        packages: [
          {
            registryType: "npm",
            identifier: "@example/files-mcp",
            transport: { type: "stdio" },
          },
        ],
      },
    }),
    await manifest({
      kind: "skill",
      name: "dev.ocean.skills.tampered",
      version: "1.0.0",
      source: { type: "path", path: "skills/ship-1" },
      integrity: { sha256: "0".repeat(64) },
      spec: { directory: "tampered" },
    }),
  ];
  const writeIndex = (list) =>
    writeFile(
      path.join(index, "ocean-marketplace.json"),
      JSON.stringify({ schemaVersion: 1, name: "test", capabilities: list }),
    );
  await writeIndex(capabilities);
  const dirs = {
    hub: path.join(root, "hub"),
    mcp: path.join(root, "mcp"),
    plugins: path.join(root, "plugins"),
    store: path.join(root, "store"),
    lock: path.join(root, "installed", "ocean.lock"),
  };
  const service = (consent = async () => true) => {
    const registry = new CapabilityRegistry();
    registry.register(createSkillAdapter(() => dirs.hub));
    registry.register(createMcpAdapter(() => dirs.mcp));
    registry.register(createPluginAdapter(() => dirs.plugins));
    return new MarketplaceService({
      registry,
      catalog: new CapabilityCatalog([
        new LocalIndexSource(path.join(index, "ocean-marketplace.json")),
      ]),
      storeDir: dirs.store,
      lockFile: dirs.lock,
      consent,
    });
  };
  return { root, index, capabilities, writeIndex, manifest, dirs, service };
}

test("content digest frames entries so different trees never collide", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-digest-"));
  await writeTree(path.join(root, "one"), { a: "bX" });
  await writeTree(path.join(root, "two"), { ab: "X" });
  assert.notEqual(
    await contentDigest(path.join(root, "one")),
    await contentDigest(path.join(root, "two")),
  );
});

test("offline install, update and uninstall of a skill from a local index", async () => {
  const { dirs, service, capabilities, writeIndex, manifest } = await fixture();
  const market = service();
  assert.deepEqual(await market.install("dev.ocean.skills.ship"), {
    name: "dev.ocean.skills.ship",
    version: "1.0.0",
    status: "installed",
  });
  assert.match(
    await readFile(path.join(dirs.hub, "ship", "SKILL.md"), "utf8"),
    /v1/,
  );
  assert.equal(
    (await market.install("dev.ocean.skills.ship")).status,
    "unchanged",
  );

  await writeIndex([
    ...capabilities,
    await manifest({
      ...capabilities[0],
      version: "1.1.0",
      integrity: undefined,
      source: { type: "path", path: "skills/ship-2" },
    }),
  ]);
  assert.deepEqual(await market.update("dev.ocean.skills.ship"), {
    name: "dev.ocean.skills.ship",
    version: "1.1.0",
    status: "updated",
    previous: "1.0.0",
  });
  assert.match(
    await readFile(path.join(dirs.hub, "ship", "SKILL.md"), "utf8"),
    /v2/,
  );
  const lock = JSON.parse(await readFile(dirs.lock, "utf8"));
  assert.equal(
    lock.installed["dev.ocean.skills.ship"].manifest.version,
    "1.1.0",
  );

  await market.uninstall("dev.ocean.skills.ship");
  assert.equal(await exists(path.join(dirs.hub, "ship")), false);
  assert.deepEqual(await market.installed(), {});
});

test("offline install and uninstall of an MCP server, permissions need consent", async () => {
  const { dirs, service } = await fixture();
  let asked;
  await assert.rejects(
    service(async (manifest) => {
      asked = manifest.name;
      return false;
    }).install("io.github.example/files"),
    /permissions not approved/,
  );
  assert.equal(asked, "io.github.example/files");
  assert.equal(await exists(dirs.lock), false);

  const market = service();
  await market.install("io.github.example/files");
  const file = path.join(dirs.mcp, "io.github.example__files.json");
  const written = JSON.parse(await readFile(file, "utf8"));
  assert.equal(written.server.packages[0].identifier, "@example/files-mcp");
  assert.deepEqual(written.permissions.filesystem.read, ["~/notes"]);
  await market.uninstall("io.github.example/files");
  assert.equal(await exists(file), false);
});

test("a wrong sha256 is refused and nothing is installed", async () => {
  const { dirs, service } = await fixture();
  await assert.rejects(
    service().install("dev.ocean.skills.tampered"),
    /Integrity check failed/,
  );
  assert.equal(await exists(path.join(dirs.hub, "tampered")), false);
  assert.equal(await exists(dirs.lock), false);
});

test("a payload changed after indexing is refused", async () => {
  const { index, service } = await fixture();
  await writeFile(path.join(index, "skills/ship-1/SKILL.md"), "changed");
  await assert.rejects(
    service().install("dev.ocean.skills.ship"),
    /Integrity check failed/,
  );
});

test("provenance that cannot be verified is refused, not ignored", async () => {
  const { capabilities, writeIndex, service } = await fixture();
  await writeIndex([
    { ...capabilities[0], provenance: { type: "sigstore", bundle: "x" } },
  ]);
  await assert.rejects(
    service().install("dev.ocean.skills.ship"),
    /cannot verify/,
  );
});

test("a skill never overwrites a directory the marketplace does not own", async () => {
  const { dirs, service } = await fixture();
  await writeTree(path.join(dirs.hub, "ship"), { "SKILL.md": "hand made" });
  await assert.rejects(
    service().install("dev.ocean.skills.ship"),
    /not managed by the marketplace/,
  );
  assert.equal(
    await readFile(path.join(dirs.hub, "ship", "SKILL.md"), "utf8"),
    "hand made",
  );
});

// One contract every adapter must satisfy: valid spec parses, bad spec is refused, install
// produces something, uninstall removes it, and a second uninstall is harmless.
const contracts = [
  {
    kind: "skill",
    adapter: (root) => createSkillAdapter(() => root),
    spec: { directory: "ship" },
    bad: [{}, { directory: "../x" }, "ship"],
    payload: { "SKILL.md": "x" },
    artifact: (root) => path.join(root, "ship", "SKILL.md"),
  },
  {
    kind: "mcp",
    adapter: (root) => createMcpAdapter(() => root),
    spec: {
      name: "io.github.x/y",
      remotes: [{ type: "streamable-http", url: "https://x.example/mcp" }],
    },
    bad: [
      {},
      { name: "y" },
      { name: "y", remotes: [{ url: "http://x" }] },
      { name: "y", packages: [{}] },
    ],
    payload: { "README.md": "x" },
    artifact: (root) => path.join(root, "dev.ocean.contract.json"),
  },
  {
    kind: "plugin",
    adapter: (root) => createPluginAdapter(() => root),
    spec: { directory: "lint" },
    bad: [{}, { directory: "lint", entry: "../plugin.json" }],
    payload: { ".claude-plugin/plugin.json": "{}" },
    artifact: (root) =>
      path.join(root, "lint", ".claude-plugin", "plugin.json"),
  },
];

for (const contract of contracts)
  test(`${contract.kind} adapter satisfies the capability adapter contract`, async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), `ocean-contract-${contract.kind}-`),
    );
    const target = path.join(root, "target");
    const contentDir = path.join(root, "payload");
    await writeTree(contentDir, contract.payload);
    const adapter = contract.adapter(target);
    assert.equal(adapter.kind, contract.kind);
    for (const bad of contract.bad)
      assert.throws(
        () => adapter.parseSpec(bad),
        undefined,
        JSON.stringify(bad),
      );
    const spec = adapter.parseSpec(contract.spec);
    const manifest = {
      name: "dev.ocean.contract",
      version: "1.0.0",
      permissions: {},
    };
    await adapter.install({ manifest, spec, contentDir });
    assert.equal(await exists(contract.artifact(target)), true);
    await adapter.uninstall({ manifest, spec });
    assert.equal(await exists(contract.artifact(target)), false);
    await adapter.uninstall({ manifest, spec });
  });

test("ocean market installs, lists and uninstalls from a local index", async () => {
  const { root, index } = await fixture();
  const env = { ...process.env, OCEAN_ROOT: path.join(root, "workspace") };
  const run = (...args) =>
    spawnSync(process.execPath, [cli, "market", ...args], {
      encoding: "utf8",
      env,
    });
  const indexArgs = ["--index", path.join(index, "ocean-marketplace.json")];

  const refused = run("install", "io.github.example/files", ...indexArgs);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /requests permissions[\s\S]*--yes/);

  const installed = run(
    "install",
    "--yes",
    "io.github.example/files",
    ...indexArgs,
  );
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(JSON.parse(installed.stdout).status, "installed");
  const listed = JSON.parse(run("list").stdout);
  assert.deepEqual(
    listed.map((item) => [item.name, item.kind, item.version]),
    [["io.github.example/files", "mcp", "0.1.0"]],
  );
  const removed = run("uninstall", "io.github.example/files", ...indexArgs);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(JSON.parse(run("list").stdout), []);
  assert.equal(run("bogus").status, 1);
});

test("a failed update puts the previous version back", async () => {
  const { index, dirs, service, capabilities, writeIndex, manifest } =
    await fixture();
  const market = service();
  await market.install("dev.ocean.skills.ship");
  await writeTree(path.join(index, "skills/broken"), {
    "README.md": "no SKILL.md here",
  });
  await writeIndex([
    ...capabilities,
    await manifest({
      ...capabilities[0],
      version: "2.0.0",
      integrity: undefined,
      source: { type: "path", path: "skills/broken" },
    }),
  ]);
  await assert.rejects(market.update("dev.ocean.skills.ship"), /no SKILL.md/);
  assert.match(
    await readFile(path.join(dirs.hub, "ship", "SKILL.md"), "utf8"),
    /v1/,
  );
  assert.equal(
    (await market.installed())["dev.ocean.skills.ship"].manifest.version,
    "1.0.0",
  );
});
