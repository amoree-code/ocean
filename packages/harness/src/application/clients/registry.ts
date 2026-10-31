import {
  type Editor,
  jsonEditor,
  manualEditor,
  type ServerValue,
  tomlEditor,
  yamlEditor,
} from "./editors.js";

// Every AI client and IDE Ocean knows how to find (T-296 P2). One row per client: where it is
// detected, which file holds its MCP servers and how that file is edited. Clients that cannot
// reach a local MCP server are listed too, with the reason and the fallback, so `ocean clients
// detect` and the doctor account for everything installed.

export type ClientTier =
  | "supported"
  | "context-file"
  | "unsupported"
  | "unknown";

export type NativeMemoryPolicy =
  | "redirect-staging"
  | "disable"
  | "harvest"
  | "owner-toggle"
  | "none"
  | "unknown";

export type ClientAdapter = {
  id: string;
  label: string;
  tier: ClientTier;
  // Home-relative paths and command names whose presence means "installed".
  detect: { paths?: string[]; binaries?: string[]; apps?: string[] };
  // Home-relative config file holding the MCP server table, and its editor.
  config?: { file: string; editor: Editor };
  nativeMemory: NativeMemoryPolicy;
  reason?: string;
  fallback?: string;
};

// OpenCode stores `{ type: "local", command: [cmd, ...args], enabled }`.
const opencodeEditor = jsonEditor(
  ["mcp"],
  (value) => ({
    type: "local",
    command: [value.command, ...((value.args as unknown[]) ?? [])],
    enabled: true,
  }),
  (node) => {
    const raw = (node ?? {}) as Record<string, unknown>;
    const command = Array.isArray(raw.command) ? raw.command : [];
    const rest = Object.fromEntries(
      Object.entries(raw).filter(
        ([key]) => !["type", "command", "enabled"].includes(key),
      ),
    );
    return {
      ...rest,
      command: command[0],
      args: command.slice(1),
    } as ServerValue;
  },
);

export const CLIENT_ADAPTERS: ClientAdapter[] = [
  {
    id: "claude-code",
    label: "Claude Code (CLI and IDE extensions)",
    tier: "supported",
    detect: { binaries: ["claude"], paths: [".claude.json"] },
    config: { file: ".claude.json", editor: jsonEditor(["mcpServers"]) },
    nativeMemory: "redirect-staging",
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    tier: "supported",
    detect: {
      apps: ["Claude.app"],
      paths: ["Library/Application Support/Claude"],
    },
    config: {
      file: "Library/Application Support/Claude/claude_desktop_config.json",
      editor: jsonEditor(["mcpServers"]),
    },
    nativeMemory: "owner-toggle",
  },
  {
    id: "codex",
    label: "Codex CLI",
    tier: "supported",
    detect: { binaries: ["codex"], paths: [".codex/config.toml"] },
    config: { file: ".codex/config.toml", editor: tomlEditor("mcp_servers") },
    nativeMemory: "disable",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    tier: "supported",
    detect: { binaries: ["gemini"], paths: [".gemini/settings.json"] },
    config: {
      file: ".gemini/settings.json",
      editor: jsonEditor(["mcpServers"]),
    },
    nativeMemory: "disable",
  },
  {
    id: "antigravity",
    label: "Antigravity",
    tier: "supported",
    detect: {
      binaries: ["agy", "antigravity"],
      apps: ["Antigravity.app"],
      paths: [".gemini/antigravity/mcp_config.json"],
    },
    config: {
      file: ".gemini/antigravity/mcp_config.json",
      editor: jsonEditor(["mcpServers"]),
    },
    nativeMemory: "harvest",
  },
  {
    id: "cursor",
    label: "Cursor",
    tier: "supported",
    detect: {
      binaries: ["cursor-agent", "cursor"],
      apps: ["Cursor.app"],
      paths: [".cursor/mcp.json"],
    },
    config: { file: ".cursor/mcp.json", editor: jsonEditor(["mcpServers"]) },
    nativeMemory: "owner-toggle",
  },
  {
    id: "hermes",
    label: "Hermes",
    tier: "supported",
    detect: { binaries: ["hermes"], paths: [".hermes/config.yaml"] },
    config: { file: ".hermes/config.yaml", editor: yamlEditor("mcp_servers") },
    nativeMemory: "disable",
  },
  {
    id: "opencode",
    label: "OpenCode",
    tier: "supported",
    detect: {
      binaries: ["opencode"],
      paths: [".config/opencode/opencode.json"],
    },
    config: { file: ".config/opencode/opencode.json", editor: opencodeEditor },
    nativeMemory: "none",
  },
  {
    id: "qwen",
    label: "Qwen Code",
    tier: "supported",
    detect: { binaries: ["qwen"], paths: [".qwen/settings.json"] },
    config: { file: ".qwen/settings.json", editor: jsonEditor(["mcpServers"]) },
    nativeMemory: "unknown",
  },
  {
    id: "continue",
    label: "Continue (VS Code)",
    tier: "supported",
    detect: { paths: [".continue/config.yaml"] },
    config: { file: ".continue/config.yaml", editor: manualEditor },
    nativeMemory: "none",
    reason: "its mcpServers is a YAML list; Ocean does not rewrite it",
  },
  {
    id: "aider",
    label: "Aider",
    tier: "context-file",
    detect: { binaries: ["aider"] },
    nativeMemory: "none",
    reason: "no MCP support",
    fallback:
      "pass an Ocean context file with --read; use `ocean memory …` for memory",
  },
  {
    id: "chatgpt",
    label: "ChatGPT desktop",
    tier: "unsupported",
    detect: { apps: ["ChatGPT.app"] },
    nativeMemory: "owner-toggle",
    reason: "cannot launch a local MCP server",
    fallback: "export the account data and import it as candidates",
  },
  {
    id: "warp",
    label: "Warp",
    tier: "unknown",
    detect: { apps: ["Warp.app"], paths: [".warp"] },
    nativeMemory: "unknown",
    reason: "MCP configuration location not verified",
  },
  {
    id: "xcode",
    label: "Xcode",
    tier: "unknown",
    detect: { apps: ["Xcode.app"] },
    nativeMemory: "unknown",
    reason: "AI/MCP support not verified",
  },
];

export function clientAdapter(id: string): ClientAdapter {
  const adapter = CLIENT_ADAPTERS.find((item) => item.id === id);
  if (!adapter) throw new Error(`Unknown client: ${id}`);
  return adapter;
}
