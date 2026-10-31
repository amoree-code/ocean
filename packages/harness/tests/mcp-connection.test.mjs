import assert from "node:assert/strict";
import test from "node:test";
import {
  obsidianMcpConfig,
  oceanMcpConfig,
  playwrightMcpConfig,
} from "@ocean/market/mcp/mcp-connection.js";

test("generates one provider-neutral stdio MCP config", () => {
  const config = obsidianMcpConfig();
  // `ocean` is the brain server's key; the vault server never takes it (T-296).
  assert.deepEqual(Object.keys(config.mcpServers), ["ocean-obsidian"]);
  const server = config.mcpServers["ocean-obsidian"];
  assert.equal(server.type, "stdio");
  assert.equal(server.args.at(-2), "obsidian");
  assert.equal(server.args.at(-1), "mcp");
  assert.match(server.command, /node/);
});

test("the brain server alone is keyed ocean", () => {
  const config = oceanMcpConfig();
  assert.deepEqual(Object.keys(config.mcpServers), ["ocean"]);
  assert.deepEqual(config.mcpServers.ocean.args.slice(-2), ["mcp", "serve"]);
});

test("generates a client-neutral Playwright MCP config", () => {
  const config = playwrightMcpConfig();
  assert.equal(config.mcpServers.playwright.command, "npx");
  assert.deepEqual(config.mcpServers.playwright.args, [
    "@playwright/mcp@latest",
    "--extension",
  ]);
});
