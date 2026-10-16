import { readdir, readFile } from "node:fs/promises";
import {
  actionFingerprint,
  mcpApprovalSchema,
} from "@ocean/core/domain/mcp/mcp-contract.js";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import {
  listInboxCandidates,
  promoteInboxNote,
} from "../../application/obsidian/inbox-promotion.js";
import {
  discoverObsidianVault,
  loadObsidianConnection,
  type ObsidianConnection,
  validateObsidianVault,
} from "../../application/obsidian/vault-discovery.js";
import { syncObsidianVault } from "../../application/obsidian/vault-sync.js";
import {
  resolveObsidianNotePath,
  writeObsidianNote,
} from "../../application/obsidian/vault-writer.js";

type Request = {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
};
type Response = {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
};

const tools = [
  {
    name: "obsidian_discover",
    description: "List Obsidian Markdown notes and metadata issues.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "obsidian_sync",
    description:
      "Compare the configured Obsidian vault with Ocean metadata state.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "obsidian_read",
    description: "Read one validated Markdown note by relative path.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "obsidian_inbox_list",
    description: "List raw notes waiting in 00-Inbox.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "obsidian_conflicts_list",
    description:
      "List Ocean-recorded Obsidian write conflicts without proposed note content.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "obsidian_write",
    description: "Plan or apply a guarded Obsidian note write.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        expectedSha256: { type: ["string", "null"] },
        approved: { type: "boolean" },
      },
      required: ["path", "content", "approved"],
      additionalProperties: false,
    },
  },
  {
    name: "obsidian_inbox_promote",
    description:
      "Plan or apply promotion of one inbox note into an approved vault area.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        targetDirectory: { type: "string" },
        approved: { type: "boolean" },
      },
      required: ["source", "targetDirectory", "approved"],
      additionalProperties: false,
    },
  },
];

function textResult(value: unknown): {
  content: [{ type: "text"; text: string }];
  structuredContent: unknown;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value)
    throw new Error(`${key} is required`);
  return value;
}

function requiredText(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`${key} is required`);
  return value;
}

async function conflicts(): Promise<unknown[]> {
  const directory = oceanPath(
    SYSTEM_DIR,
    "integrations",
    "obsidian",
    "conflicts",
  );
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => ({ record: entry.name }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  connection: ObsidianConnection,
): Promise<unknown> {
  await validateObsidianVault(connection);
  if (name === "obsidian_discover") {
    const result = await discoverObsidianVault(connection);
    return {
      noteCount: result.noteCount,
      totalBytes: result.totalBytes,
      notes: result.notes,
      issues: result.issues,
    };
  }
  if (name === "obsidian_sync") return syncObsidianVault(connection);
  if (name === "obsidian_read") {
    const relative = requiredString(args, "path");
    const file = resolveObsidianNotePath(connection.vaultPath, relative);
    const content = await readFile(file, "utf8");
    if (Buffer.byteLength(content) > 1_000_000)
      throw new Error("Obsidian note exceeds 1000000 bytes");
    return { path: relative, content };
  }
  if (name === "obsidian_inbox_list") return listInboxCandidates(connection);
  if (name === "obsidian_conflicts_list") return conflicts();
  if (name === "obsidian_write") {
    const approval = mcpApprovalSchema.parse(args.approval);
    const actionArgs = {
      path: args.path,
      content: args.content,
      ...(args.expectedSha256 === undefined
        ? {}
        : { expectedSha256: args.expectedSha256 }),
    };
    if (approval.fingerprint !== actionFingerprint(name, actionArgs))
      throw new Error(
        "Obsidian write approval does not match the requested action",
      );
    return writeObsidianNote(
      connection,
      requiredString(args, "path"),
      requiredText(args, "content"),
      args.expectedSha256 === null || args.expectedSha256 === undefined
        ? null
        : requiredString(args, "expectedSha256"),
      true,
    );
  }
  if (name === "obsidian_inbox_promote") {
    const approval = mcpApprovalSchema.parse(args.approval);
    const actionArgs = {
      source: args.source,
      targetDirectory: args.targetDirectory,
    };
    if (approval.fingerprint !== actionFingerprint(name, actionArgs))
      throw new Error(
        "Inbox promotion approval does not match the requested action",
      );
    return promoteInboxNote(
      connection,
      requiredString(args, "source"),
      requiredString(args, "targetDirectory"),
      true,
    );
  }
  throw new Error(`Unknown MCP tool: ${name}`);
}

export async function handleObsidianMcpRequest(
  request: Request,
  connection: ObsidianConnection,
): Promise<Response | null> {
  if (request.method === "notifications/initialized") return null;
  if (request.method === "initialize")
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "ocean-obsidian", version: "0.3.6" },
      },
    };
  if (request.method === "tools/list")
    return { jsonrpc: "2.0", id: request.id, result: { tools } };
  if (request.method !== "tools/call")
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32601,
        message: `Unsupported MCP method: ${request.method ?? ""}`,
      },
    };
  const name = request.params?.name;
  if (typeof name !== "string" || !tools.some((tool) => tool.name === name))
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32602, message: "Unknown MCP tool" },
    };
  try {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: textResult(
        await callTool(
          name,
          (request.params?.arguments ?? {}) as Record<string, unknown>,
          connection,
        ),
      ),
    };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function runObsidianMcpServer(): Promise<void> {
  const connection = await loadObsidianConnection();
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk: string) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const request = JSON.parse(line) as Request;
      const response = await handleObsidianMcpRequest(request, connection);
      if (!response) continue;
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
  await new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
  });
}
