import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { actionFingerprint } from "@ocean/core/domain/mcp/mcp-contract.js";
import { SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { McpClient } from "../dist/infrastructure/mcp/mcp-client.js";
import { handleObsidianMcpRequest } from "../dist/infrastructure/mcp/obsidian-server.js";

test("Obsidian MCP exposes bounded tools and requires approval for writes", async () => {
  const vaultPath = await mkdtemp(
    path.join(os.tmpdir(), "ocean-obsidian-mcp-"),
  );
  await mkdir(path.join(vaultPath, ".obsidian"));
  await writeFile(path.join(vaultPath, "note.md"), "# Note\n");
  const connection = { enabled: true, mode: "read-only", vaultPath };
  const listed = await handleObsidianMcpRequest(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    connection,
  );
  assert.equal(listed.result.tools.length, 7);
  const read = await handleObsidianMcpRequest(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "obsidian_read", arguments: { path: "note.md" } },
    },
    connection,
  );
  assert.match(read.result.content[0].text, /# Note/);
  const rejected = await handleObsidianMcpRequest(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "obsidian_write",
        arguments: { path: "note.md", content: "changed", approval: {} },
      },
    },
    connection,
  );
  assert.match(rejected.error.message, /expected true|Required/);
});

test("MCP client completes a real Ocean-to-Obsidian round trip", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-obsidian-mcp-e2e-"));
  const vaultPath = path.join(root, "vault");
  await mkdir(path.join(root, SYSTEM_DIR, "integrations", "obsidian"), {
    recursive: true,
  });
  await mkdir(vaultPath);
  await mkdir(path.join(vaultPath, ".obsidian"));
  await writeFile(
    path.join(root, SYSTEM_DIR, "integrations", "obsidian", "connection.json"),
    JSON.stringify({ enabled: true, mode: "read-write", vaultPath }),
  );
  const client = new McpClient({
    command: process.execPath,
    args: [path.resolve("dist/main.js"), "obsidian", "mcp"],
    cwd: path.resolve("."),
    env: { OCEAN_ROOT: root },
    allowedTools: ["obsidian_write", "obsidian_read"],
  });
  try {
    await client.connect();
    const written = await client.callTool(
      "obsidian_write",
      { path: "01-Projects/round-trip.md", content: "from Ocean" },
      true,
    );
    assert.match(written.content[0].text, /"applied":true/);
    assert.equal(
      await readFile(path.join(vaultPath, "01-Projects/round-trip.md"), "utf8"),
      "from Ocean",
    );
    const read = await client.callTool("obsidian_read", {
      path: "01-Projects/round-trip.md",
    });
    assert.match(read.content[0].text, /from Ocean/);
  } finally {
    client.close();
  }
});

test("MCP rejects an approval fingerprint for a different write", async () => {
  const vaultPath = await mkdtemp(
    path.join(os.tmpdir(), "ocean-obsidian-mcp-fingerprint-"),
  );
  await mkdir(path.join(vaultPath, ".obsidian"));
  const connection = { enabled: true, mode: "read-write", vaultPath };
  const result = await handleObsidianMcpRequest(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "obsidian_write",
        arguments: {
          path: "note.md",
          content: "new",
          approval: {
            approved: true,
            fingerprint: actionFingerprint("obsidian_write", {
              path: "other.md",
              content: "new",
              expectedSha256: null,
            }),
          },
        },
      },
    },
    connection,
  );
  assert.match(result.error.message, /does not match/);
});
