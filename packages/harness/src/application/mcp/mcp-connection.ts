import path from "node:path";
import { engineRoot } from "../../paths.js";

export type StdioMcpServer = {
  type: "stdio";
  command: string;
  args: string[];
  cwd: string;
};

export function oceanMcpConfig(): { mcpServers: { ocean: StdioMcpServer } } {
  return {
    mcpServers: {
      ocean: {
        type: "stdio",
        command: process.execPath,
        args: [path.join(engineRoot(), "dist", "main.js"), "mcp", "serve"],
        cwd: engineRoot(),
      },
    },
  };
}

export function obsidianMcpConfig(): { mcpServers: { ocean: StdioMcpServer } } {
  return {
    mcpServers: {
      ocean: {
        type: "stdio",
        command: process.execPath,
        args: [path.join(engineRoot(), "dist", "main.js"), "obsidian", "mcp"],
        cwd: engineRoot(),
      },
    },
  };
}

export type PlaywrightMcpServer = {
  command: string;
  args: string[];
};

export function playwrightMcpConfig(): {
  mcpServers: { playwright: PlaywrightMcpServer };
} {
  return {
    mcpServers: {
      playwright: {
        command: "npx",
        args: ["@playwright/mcp@latest", "--extension"],
      },
    },
  };
}
