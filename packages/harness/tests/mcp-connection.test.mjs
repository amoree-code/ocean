import assert from "node:assert/strict";
import test from "node:test";
import {
  obsidianMcpConfig,
  playwrightMcpConfig,
} from "../dist/application/mcp/mcp-connection.js";

test("generates one provider-neutral stdio MCP config", () => {
  const config = obsidianMcpConfig();
  assert.equal(config.mcpServers.ocean.type, "stdio");
  assert.equal(config.mcpServers.ocean.args.at(-2), "obsidian");
  assert.equal(config.mcpServers.ocean.args.at(-1), "mcp");
  assert.match(config.mcpServers.ocean.command, /node/);
});

test("generates a client-neutral Playwright MCP config", () => {
  const config = playwrightMcpConfig();
  assert.equal(config.mcpServers.playwright.command, "npx");
  assert.deepEqual(config.mcpServers.playwright.args, [
    "@playwright/mcp@latest",
    "--extension",
  ]);
});
