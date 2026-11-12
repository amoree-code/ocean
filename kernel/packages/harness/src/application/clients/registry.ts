import {
  type Editor,
  jsonEditor,
  type ServerValue,
  tomlEditor,
  yamlEditor,
  yamlListEditor,
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
  | "capture"
  | "uncaptured"
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
  // The MCP `clientInfo.name` it sends Ocean, as the call ledger records it (T-307), with the
  // mode when the client sends a different name per mode. Only names seen in the ledger with
  // the client identified; no name belongs to two clients.
  mcpClients?: { name: string; mode?: string }[];
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
    mcpClients: [{ name: "claude-code" }],
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
    nativeMemory: "capture",
    // Normal chat uses the claude.ai name although it runs locally; agent mode names its own
    // `local-agent-mode-<server>` client.
    mcpClients: [
      { name: "claude-ai", mode: "chat" },
      { name: "local-agent-mode-ocean", mode: "agent" },
    ],
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
    // The current `agy` CLI reads its own table (`agy mcp list`), not the app's file above (T-298).
    id: "antigravity-cli",
    label: "Antigravity CLI (agy)",
    tier: "supported",
    detect: { binaries: ["agy"], paths: [".gemini/config/mcp_config.json"] },
    config: {
      file: ".gemini/config/mcp_config.json",
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
    nativeMemory: "uncaptured",
  },
  {
    // VS Code's own MCP support (Copilot agent mode): `servers`, each with a `type`.
    id: "vscode",
    label: "VS Code",
    tier: "supported",
    detect: {
      binaries: ["code"],
      apps: ["Visual Studio Code.app"],
      paths: ["Library/Application Support/Code/User"],
    },
    config: {
      file: "Library/Application Support/Code/User/mcp.json",
      editor: jsonEditor(["servers"], (value) => ({ type: "stdio", ...value })),
    },
    nativeMemory: "unknown",
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
    mcpClients: [{ name: "opencode" }],
  },
  {
    id: "qwen",
    label: "Qwen Code",
    tier: "supported",
    detect: { binaries: ["qwen"], paths: [".qwen/settings.json"] },
    config: { file: ".qwen/settings.json", editor: jsonEditor(["mcpServers"]) },
    nativeMemory: "disable",
  },
  {
    id: "continue",
    label: "Continue (VS Code)",
    tier: "supported",
    detect: { paths: [".continue/config.yaml"] },
    config: {
      file: ".continue/config.yaml",
      editor: yamlListEditor("mcpServers"),
    },
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
    nativeMemory: "capture",
    reason: "cannot launch a local MCP server",
    fallback:
      "`ocean pull` captures its conversations and memory from the browsers' caches",
  },
  {
    id: "warp",
    label: "Warp",
    // Unsupported until its MCP support is verified (T-307), not left as an open question.
    tier: "unsupported",
    detect: { apps: ["Warp.app"], paths: [".warp"] },
    nativeMemory: "unknown",
    reason: "MCP support not verified",
    fallback: "use Ocean from a supported client or the `ocean` CLI",
  },
  {
    id: "xcode",
    label: "Xcode",
    tier: "unsupported",
    detect: { apps: ["Xcode.app"] },
    nativeMemory: "unknown",
    reason: "AI/MCP support not verified",
    fallback: "use Ocean from a supported client or the `ocean` CLI",
  },
];

// Which client, and which of its modes, a call-ledger name belongs to; undefined when unknown.
export function mcpClientOf(
  name: string,
): { id: string; mode?: string } | undefined {
  for (const adapter of CLIENT_ADAPTERS) {
    const known = adapter.mcpClients?.find((item) => item.name === name);
    if (known)
      return known.mode
        ? { id: adapter.id, mode: known.mode }
        : { id: adapter.id };
  }
  return undefined;
}

export function clientAdapter(id: string): ClientAdapter {
  const adapter = CLIENT_ADAPTERS.find((item) => item.id === id);
  if (!adapter) throw new Error(`Unknown client: ${id}`);
  return adapter;
}
