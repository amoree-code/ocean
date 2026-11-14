import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fetchRegistryServer,
  registryBase,
  searchRegistry,
} from "@ocean/market/registry/official-registry.js";

const cli = path.resolve("dist/main.js");

const notes = {
  name: "io.github.me/Notes",
  version: "1.4.0",
  description: "Reads and writes notes.",
  packages: [
    {
      registryType: "npm",
      identifier: "@me/notes-mcp",
      version: "1.4.0",
      environmentVariables: [
        { name: "NOTES_TOKEN", isRequired: true, isSecret: true },
      ],
    },
  ],
};
const hosted = {
  name: "com.example/hosted",
  version: "2.0.0",
  description: "A hosted server.",
  remotes: [
    {
      type: "streamable-http",
      url: "https://mcp.example.com/mcp",
      headers: [{ name: "Authorization", isRequired: true, isSecret: true }],
    },
  ],
};
const meta = (status = "active") => ({
  "io.modelcontextprotocol.registry/official": { status, isLatest: true },
});

// The two endpoints of the official registry Ocean uses, on loopback.
async function fakeRegistry() {
  const latest = {
    "io.github.me/Notes": { server: notes, _meta: meta() },
    "com.example/hosted": { server: hosted, _meta: meta("deprecated") },
    "com.example/gone": {
      server: { name: "com.example/gone", packages: [] },
      _meta: meta("deleted"),
    },
    "com.example/liar": { server: notes, _meta: meta() },
  };
  const searches = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, body) =>
      res
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(body));
    if (url.pathname === "/v0/servers") {
      searches.push(url.searchParams.get("search"));
      return send(200, {
        servers: [
          { server: notes, _meta: meta() },
          { server: notes, _meta: meta() },
          { server: hosted, _meta: meta("deprecated") },
          latest["com.example/gone"],
        ],
        metadata: { count: 4 },
      });
    }
    const match = url.pathname.match(
      /^\/v0\/servers\/([^/]+)\/versions\/latest$/,
    );
    const name = match && decodeURIComponent(match[1]);
    if (name === "com.example/hop")
      return res.writeHead(302, { location: "https://evil.example/" }).end();
    if (name && latest[name]) return send(200, latest[name]);
    send(404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    env: { OCEAN_MCP_REGISTRY: `http://127.0.0.1:${server.address().port}/` },
    searches,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("the registry is the official one unless set, and only https or loopback", () => {
  assert.equal(
    registryBase({}).href,
    "https://registry.modelcontextprotocol.io/",
  );
  assert.throws(
    () => registryBase({ OCEAN_MCP_REGISTRY: "http://mirror.example.com/" }),
    /must be https/,
  );
});

test("search lists each server once with how it runs and what it needs; fetch checks the answer", async () => {
  const registry = await fakeRegistry();
  try {
    const hits = await searchRegistry("notes", { env: registry.env });
    assert.deepEqual(registry.searches, ["notes"]);
    assert.deepEqual(hits, [
      {
        name: "io.github.me/Notes",
        version: "1.4.0",
        description: "Reads and writes notes.",
        status: "active",
        runs: "npm",
        needs: ["NOTES_TOKEN"],
      },
      {
        name: "com.example/hosted",
        version: "2.0.0",
        description: "A hosted server.",
        status: "deprecated",
        runs: "remote streamable-http",
        needs: ["Authorization"],
      },
    ]);
    const found = await fetchRegistryServer("io.github.me/Notes", {
      env: registry.env,
    });
    assert.equal(found.server.version, "1.4.0");
    await assert.rejects(
      fetchRegistryServer("com.example/gone", { env: registry.env }),
      /deleted from the MCP registry/,
    );
    await assert.rejects(
      fetchRegistryServer("com.example/missing", { env: registry.env }),
      /is not in the MCP registry/,
    );
    await assert.rejects(
      fetchRegistryServer("com.example/liar", { env: registry.env }),
      /answered io\.github\.me\/Notes for com\.example\/liar/,
    );
    await assert.rejects(
      fetchRegistryServer("com.example/hop", { env: registry.env }),
    );
  } finally {
    await registry.close();
  }
});

function run(env, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// The definition of done for adding by name: one command from the registry to installed, through
// the same scan, consent and lock, and it says which value is still missing.
test("ocean market search and add install a server by its registry name", async () => {
  const registry = await fakeRegistry();
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-market-registry-"));
  const env = { ...registry.env, OCEAN_ROOT: path.join(root, "workspace") };
  try {
    const search = await run(env, "market", "search", "notes");
    assert.equal(search.status, 0, search.stderr);
    assert.match(
      search.stdout,
      /io\.github\.me\/Notes@1\.4\.0 {2}\[npm, needs NOTES_TOKEN\]/,
    );
    assert.match(search.stdout, /\[remote streamable-http, deprecated/);

    const refused = await run(env, "market", "add", "io.github.me/Notes");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /"env":\["NOTES_TOKEN"\].*"exec":\["npx"\]/);

    const added = await run(
      env,
      "market",
      "add",
      "io.github.me/Notes",
      "--yes",
    );
    assert.equal(added.status, 0, added.stderr);
    assert.deepEqual(JSON.parse(added.stdout), {
      name: "io.github.me/notes",
      version: "1.4.0",
      status: "installed",
    });
    assert.match(
      added.stderr,
      /io\.github\.me\/notes needs NOTES_TOKEN: ocean market secret set io\.github\.me\/notes NOTES_TOKEN/,
    );
    const listed = await run(
      env,
      "market",
      "secret",
      "list",
      "io.github.me/notes",
    );
    assert.equal(listed.status, 0, listed.stderr);
    const [input] = JSON.parse(listed.stdout);
    assert.equal(input.name, "NOTES_TOKEN");
    assert.ok(["missing", "macOS keychain"].includes(input.from));
    const fromEnv = await run(
      { ...env, NOTES_TOKEN: "x" },
      "market",
      "secret",
      "list",
      "io.github.me/notes",
    );
    assert.equal(JSON.parse(fromEnv.stdout)[0].from, "environment");
    const unknown = await run(
      env,
      "market",
      "secret",
      "set",
      "io.github.me/notes",
      "OTHER",
    );
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /takes NOTES_TOKEN/);

    const deprecated = await run(
      env,
      "market",
      "add",
      "com.example/hosted",
      "--yes",
    );
    assert.equal(deprecated.status, 0, deprecated.stderr);
    assert.match(deprecated.stderr, /com\.example\/hosted is deprecated/);
    assert.match(deprecated.stderr, /needs Authorization/);
  } finally {
    await registry.close();
  }
});
