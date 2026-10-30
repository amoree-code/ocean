import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  brainNeighbors,
  brainRead,
  brainSearch,
} from "@ocean/brain/brain/brain-service.js";
import { writeMemoryRecord } from "@ocean/brain/memory/memory-write.js";
import { promoteSessionToKnowledge } from "@ocean/brain/memory/session-promotion.js";
import { isValidProjectId } from "@ocean/core/domain/context/project-id.js";
import {
  actionFingerprint,
  mcpApprovalSchema,
} from "@ocean/core/domain/mcp/mcp-contract.js";
import type { BrainIndexPort } from "@ocean/core/domain/ports/brain-index-port.js";
import type { WrapperManagerPort } from "@ocean/core/domain/ports/platform-ports.js";
import type { SessionStoreFactory } from "@ocean/core/domain/ports/session-store-port.js";
import { oceanPath, oceanRoot, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { folderProject } from "@ocean/core/shared/project-resolution.js";
import {
  getHandoff,
  getTask,
  listHandoffs,
} from "@ocean/loop/handoff/handoff-service.js";
import { openSessionStoreReadOnly } from "@ocean/loop/infrastructure/persistence/session-store.js";
import { listTasksForFolder } from "@ocean/loop/tasks/list-tasks.js";
import { hasFailures, workspaceReport } from "../../doctor/workspace-doctor.js";
import { McpToolRegistry } from "./tool-registry.js";

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

const tools = new McpToolRegistry([
  {
    name: "ocean_status",
    description: "Return the Ocean runtime and workspace status.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "ocean_doctor",
    description: "Run the read-only Ocean workspace health checks.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "ocean_profiles_list",
    description: "List available Ocean profiles.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "ocean_tasks_list",
    description:
      "List Ocean tasks for the folder being worked in: that project's tasks, or every project's (labelled) when it has none or the folder is no project. Optionally filtered by state.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string" },
        project: { type: "string" },
        cwd: {
          type: "string",
          description:
            "The folder the user is working in; defaults to the server's working directory.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ocean_task_get",
    description: "Read one bounded Ocean task record.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        project: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    name: "ocean_handoffs_list",
    description: "List compact cross-client session handoffs.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" }, project: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "ocean_handoff_get",
    description: "Read one bounded cross-client session handoff.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        handoffId: { type: "string" },
        maxBytes: { type: "number" },
      },
      required: ["handoffId"],
      additionalProperties: false,
    },
  },
  {
    name: "ocean_session_get",
    description: "Read one session metadata record without its transcript.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "ocean_session_summary",
    description: "Read one bounded human-readable session summary.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        maxBytes: { type: "number" },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "ocean_session_events",
    description:
      "Read one bounded session event log explicitly requested by id.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        maxEvents: { type: "number" },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "ocean_session_promote",
    description:
      "Promote a completed session result into reviewed Ocean knowledge.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        target: { type: "string" },
        approval: { type: "object" },
      },
      required: ["sessionId", "approval"],
      additionalProperties: false,
    },
  },
  {
    name: "brain_search",
    description:
      "Search the markdown memory/knowledge index (hybrid FTS + vector when available). Shows global records plus the project (`project`, else the one bound to `cwd`); unbound sessions see global only.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        types: { type: "array", items: { type: "string" } },
        project: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "brain_read",
    description: "Read one markdown memory/knowledge record by id or path.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        path: { type: "string" },
        maxBytes: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "brain_neighbors",
    description: "Walk the wikilink graph around one memory/knowledge record.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        depth: { type: "number" },
        direction: { type: "string", enum: ["out", "in", "both"] },
        limit: { type: "number" },
        project: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_write",
    description:
      "Save a durable fact to Ocean, the one memory every client shares; never keep it only in this client's own memory. Search first with brain_search: if a record already covers the topic, brain_read it and write the whole merged record back with mode `update`; if nothing does, mode `create` a new file in the section or project it belongs to (`02-personal/<section>/<name>.md` or `04-projects/<project>/memory/<name>.md`). If it contradicts a record, say so to the user instead of overwriting. Never secrets or temporary state.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        mode: { type: "string", enum: ["create", "update"] },
      },
      required: ["path", "content", "mode"],
      additionalProperties: false,
    },
  },
]);

const resources = [
  {
    uri: "ocean://status",
    name: "Ocean status",
    description: "Current Ocean workspace health.",
  },
  {
    uri: "ocean://profiles",
    name: "Ocean profiles",
    description: "Available Ocean role profiles.",
  },
  {
    uri: "ocean://tasks",
    name: "Ocean tasks",
    description: "Current Ocean tasks.",
  },
  {
    uri: "ocean://handoffs",
    name: "Ocean handoffs",
    description: "Compact cross-client session handoffs.",
  },
];

const prompts = [
  {
    name: "ocean_review_workspace",
    description:
      "Review Ocean workspace health and summarize actionable findings.",
    arguments: [],
  },
  {
    name: "ocean_review_task",
    description: "Review one Ocean task and identify its next verified action.",
    arguments: [
      { name: "task", description: "Task identifier", required: true },
    ],
  },
];

// The ports the server reaches infrastructure through. The CLI passes the
// composition root's defaults, so this layer never imports composition.
export type OceanMcpPorts = {
  brainIndex: BrainIndexPort;
  sessionStoreFactory: SessionStoreFactory;
  wrapperManager: WrapperManagerPort;
};

function textResult(value: unknown): {
  content: [{ type: "text"; text: string }];
  structuredContent: unknown;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

async function profiles(): Promise<string[]> {
  try {
    return (
      await readdir(oceanPath(SYSTEM_DIR, "profiles"), { withFileTypes: true })
    )
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -5))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  ports: OceanMcpPorts,
): Promise<unknown> {
  if (name === "ocean_status")
    return {
      name: "Ocean",
      version: "0.3.6",
      workspace: oceanPath(),
      mcp: "stdio",
    };
  if (name === "ocean_doctor") {
    const report = await workspaceReport(ports.wrapperManager);
    return {
      healthy: !hasFailures(report.findings),
      findings: report.findings,
    };
  }
  if (name === "ocean_profiles_list") return { profiles: await profiles() };
  if (name === "ocean_tasks_list") {
    const text = (key: string) =>
      typeof args[key] === "string" && args[key] ? args[key] : undefined;
    return await listTasksForFolder({
      cwd: text("cwd") ?? process.cwd(),
      project: text("project"),
      state: text("state"),
    });
  }
  if (name === "ocean_task_get")
    return await getTask(requiredArgument(args, "taskId"), {
      projectId: typeof args.project === "string" ? args.project : undefined,
      explicit: typeof args.project === "string",
      cwd: typeof args.cwd === "string" ? args.cwd : undefined,
    });
  if (name === "ocean_handoffs_list")
    return {
      handoffs: await listHandoffs(
        ports.sessionStoreFactory,
        typeof args.taskId === "string" ? args.taskId : undefined,
        typeof args.project === "string" && args.project
          ? args.project
          : undefined,
      ),
    };
  if (name === "ocean_handoff_get")
    return await getHandoff(
      requiredArgument(args, "handoffId"),
      ports.sessionStoreFactory,
      typeof args.maxBytes === "number"
        ? Math.min(16_000, Math.max(512, args.maxBytes))
        : 8_000,
    );
  if (name === "ocean_session_get") {
    const store = await openSessionStoreReadOnly();
    try {
      const session = store.get(requiredArgument(args, "sessionId"));
      if (!session) throw new Error("Session not found");
      return session;
    } finally {
      store.close();
    }
  }
  if (name === "ocean_session_summary") {
    const store = await openSessionStoreReadOnly();
    try {
      const session = store.get(requiredArgument(args, "sessionId"));
      if (!session) throw new Error("Session not found");
      if (!session.summaryPath)
        throw new Error("Session summary not available");
      const summaryPath = path.resolve(oceanRoot(), session.summaryPath);
      const root = `${path.resolve(oceanPath(SYSTEM_DIR, "sessions", "summaries"))}${path.sep}`;
      if (!summaryPath.startsWith(root))
        throw new Error(
          "Session summary path is outside the Ocean summary directory",
        );
      const maxBytes =
        typeof args.maxBytes === "number"
          ? Math.min(12_000, Math.max(512, args.maxBytes))
          : 12_000;
      return {
        sessionId: session.sessionId,
        summaryPath: session.summaryPath,
        summary: (await readFile(summaryPath, "utf8")).slice(0, maxBytes),
      };
    } finally {
      store.close();
    }
  }
  if (name === "ocean_session_events") {
    const store = await openSessionStoreReadOnly();
    try {
      const events = store.listEvents(requiredArgument(args, "sessionId"));
      const max =
        typeof args.maxEvents === "number"
          ? Math.min(100, Math.max(1, args.maxEvents))
          : 20;
      return { events: events.slice(-max) };
    } finally {
      store.close();
    }
  }
  if (name === "ocean_session_promote") {
    const approval = mcpApprovalSchema.parse(args.approval);
    const actionArgs = {
      sessionId: args.sessionId,
      target:
        typeof args.target === "string" ? args.target : "knowledge/results",
    };
    if (approval.fingerprint !== actionFingerprint(name, actionArgs))
      throw new Error(
        "Session promotion approval does not match the requested action",
      );
    return promoteSessionToKnowledge(
      requiredArgument(args, "sessionId"),
      ports.sessionStoreFactory,
      typeof args.target === "string" ? args.target : "knowledge/results",
      true,
    );
  }
  if (name === "brain_search")
    return brainSearch({
      scope: await scopeFor(args),
      query: requiredArgument(args, "query"),
      limit:
        typeof args.limit === "number"
          ? Math.min(20, Math.max(1, args.limit))
          : undefined,
      types: Array.isArray(args.types)
        ? args.types.filter((item): item is string => typeof item === "string")
        : undefined,
      indexPort: ports.brainIndex,
    });
  if (name === "brain_read") {
    const idOrPath =
      typeof args.id === "string" && args.id
        ? args.id
        : typeof args.path === "string" && args.path
          ? args.path
          : null;
    if (!idOrPath) throw new Error("brain_read requires id or path");
    return brainRead({
      idOrPath,
      maxBytes:
        typeof args.maxBytes === "number"
          ? Math.min(16_000, Math.max(512, args.maxBytes))
          : undefined,
      indexPort: ports.brainIndex,
    });
  }
  if (name === "brain_neighbors")
    return brainNeighbors({
      scope: await scopeFor(args),
      idOrPath: requiredArgument(args, "id"),
      depth: args.depth === 2 ? 2 : 1,
      direction:
        args.direction === "out" || args.direction === "in"
          ? args.direction
          : "both",
      limit:
        typeof args.limit === "number"
          ? Math.min(50, Math.max(1, args.limit))
          : undefined,
      indexPort: ports.brainIndex,
    });
  if (name === "memory_write") {
    if (args.mode !== "create" && args.mode !== "update")
      throw new Error("mode must be create or update");
    return writeMemoryRecord({
      path: requiredArgument(args, "path"),
      content: requiredArgument(args, "content"),
      mode: args.mode,
    });
  }
  throw new Error(`Unknown MCP tool: ${name}`);
}

// Memory visibility for a tool call: an explicit project, else the one bound to the cwd.
async function scopeFor(
  args: Record<string, unknown>,
): Promise<{ project: string | null }> {
  if (typeof args.project === "string" && args.project) {
    if (!isValidProjectId(args.project))
      throw new Error(`invalid project id '${args.project}'`);
    return { project: args.project };
  }
  const cwd =
    typeof args.cwd === "string" && args.cwd ? args.cwd : process.cwd();
  return { project: await folderProject(cwd) };
}

async function readResource(
  uri: string,
  ports: OceanMcpPorts,
): Promise<{ uri: string; mimeType: string; text: string }> {
  let value: unknown;
  const resource = /^ocean:\/\/(.*)$/.exec(uri)?.[1];
  if (resource === "status") {
    const report = await workspaceReport(ports.wrapperManager);
    value = {
      name: "Ocean",
      version: "0.3.6",
      workspace: oceanPath(),
      healthy: !hasFailures(report.findings),
      findings: report.findings,
    };
  } else if (resource === "profiles") value = { profiles: await profiles() };
  else if (resource === "tasks")
    value = await listTasksForFolder({ cwd: process.cwd() });
  else if (resource === "handoffs")
    value = { handoffs: await listHandoffs(ports.sessionStoreFactory) };
  else throw new Error(`Unknown Ocean resource: ${uri}`);
  return {
    uri,
    mimeType: "application/json",
    text: JSON.stringify(value, null, 2),
  };
}

function requiredArgument(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value)
    throw new Error(`${key} is required`);
  return value;
}

async function getPrompt(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (name === "ocean_review_workspace")
    return {
      description: "Ocean workspace review",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Run ocean_doctor and summarize only actionable findings. Do not change files.",
          },
        },
      ],
    };
  if (name === "ocean_review_task") {
    const task = requiredArgument(args, "task");
    return {
      description: `Review ${task}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Read the Ocean task ${task}, report PROVEN, NOT PROVEN, or BLOCKED, and propose exactly one next verified action.`,
          },
        },
      ],
    };
  }
  throw new Error(`Unknown Ocean prompt: ${name}`);
}

export async function handleOceanMcpRequest(
  request: Request,
  ports: OceanMcpPorts,
): Promise<Response | null> {
  if (request.method === "notifications/initialized") return null;
  if (request.method === "initialize")
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "ocean", version: "0.3.6" },
      },
    };
  if (request.method === "tools/list")
    return { jsonrpc: "2.0", id: request.id, result: { tools: tools.list() } };
  if (request.method === "resources/list")
    return { jsonrpc: "2.0", id: request.id, result: { resources } };
  if (request.method === "resources/read") {
    try {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          contents: [
            await readResource(String(request.params?.uri ?? ""), ports),
          ],
        },
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
  if (request.method === "prompts/list")
    return { jsonrpc: "2.0", id: request.id, result: { prompts } };
  if (request.method === "prompts/get") {
    try {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: await getPrompt(
          String(request.params?.name ?? ""),
          (request.params?.arguments ?? {}) as Record<string, unknown>,
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
  if (typeof name !== "string" || !tools.has(name))
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
          ports,
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

export async function runOceanMcpServer(ports: OceanMcpPorts): Promise<void> {
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
      const response = await handleOceanMcpRequest(request, ports);
      if (!response) continue;
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
  await new Promise<void>((resolve) => process.stdin.once("end", resolve));
}
