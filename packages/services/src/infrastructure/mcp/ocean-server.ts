import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  brainNeighbors,
  brainRead,
  brainSearch,
} from "@ocean/brain/brain/brain-service.js";
import { memorySettings } from "@ocean/brain/memory/memory-audit.js";
import {
  deleteMemoryRecord,
  memoryHistory,
  restoreMemory,
} from "@ocean/brain/memory/memory-trash.js";
import {
  proposeMemory,
  readMemoryRecord,
  writeMemoryRecord,
} from "@ocean/brain/memory/memory-write.js";
import { promoteSessionToKnowledge } from "@ocean/brain/memory/session-promotion.js";
import { isValidProjectId } from "@ocean/core/domain/context/project-id.js";
import {
  actionFingerprint,
  mcpApprovalSchema,
} from "@ocean/core/domain/mcp/mcp-contract.js";
import {
  MEMORY_CONTRACT_VERSION,
  MEMORY_INSTRUCTIONS,
  MemoryContractError,
} from "@ocean/core/domain/mcp/memory-contract.js";
import type { BrainIndexPort } from "@ocean/core/domain/ports/brain-index-port.js";
import type { EmbedderPort } from "@ocean/core/domain/ports/embedder-port.js";
import type { WrapperManagerPort } from "@ocean/core/domain/ports/platform-ports.js";
import type { SessionStoreFactory } from "@ocean/core/domain/ports/session-store-port.js";
import { redactSecrets } from "@ocean/core/domain/redaction/redaction.js";
import { oceanPath, oceanRoot, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import {
  folderProject,
  scanProjectManifests,
} from "@ocean/core/shared/project-resolution.js";
import {
  createHandoff,
  getHandoff,
  getTask,
  listHandoffs,
} from "@ocean/loop/handoff/handoff-service.js";
import { oceanContext } from "@ocean/loop/hooks/session-start-hook.js";
import { openSessionStoreReadOnly } from "@ocean/loop/infrastructure/persistence/session-store.js";
import { listTasksForFolder } from "@ocean/loop/tasks/list-tasks.js";
import { hasFailures, workspaceReport } from "../../doctor/workspace-doctor.js";
import { recordMcpCall } from "./call-ledger.js";
import { serverVersion } from "./server-version.js";
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
  error?: { code: number; message: string; data?: Record<string, unknown> };
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
      "Call this first, before answering anything about the user, their projects, preferences or past decisions: Ocean is their memory. Searches the markdown memory/knowledge index (hybrid FTS + vector when available); read a result with brain_read and cite its path. Shows global records plus the project (`project`, else the one bound to `cwd`); unbound sessions see global only.",
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
    name: "ocean_ping",
    description: "Cheap health check: answers when the server is up.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "ocean_capabilities",
    description:
      "The memory contract version, the tool names and whether memory writes are enabled.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "memory_read",
    description:
      "Read one memory record (02-personal/... or 04-projects/<project>/memory/...) with its sha256, which memory_write update, memory_delete and memory_restore need as expectedHash.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_history",
    description:
      "Audit entries (newest first) for one record path, or for all records; ids feed memory_restore.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "number" } },
      additionalProperties: false,
    },
  },
  {
    name: "memory_write",
    description:
      "Save a fact the user explicitly asked to remember or change. Search first (brain_search): if a record covers it, memory_read it and write the merged record back with mode `update` and its sha256 as expectedHash; otherwise mode `create` in `02-personal/<section>/<name>.md` or `04-projects/<project>/memory/<name>.md`. Inferred or imported facts go to memory_propose instead. Never secrets or temporary state.",
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        mode: { type: "string", enum: ["create", "update"] },
        expectedHash: { type: "string" },
        allowSimilar: { type: "boolean" },
      },
      required: ["path", "content", "mode"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_propose",
    description:
      "Call this when the user states something worth keeping across sessions (a decision, preference or project fact) without asking you to remember it, for a fact you inferred, or for one imported from another tool's memory: it queues it for the user's review. It is not memory until approved. Optionally name the record it should become (target) and why (reason).",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        origin: { type: "string", enum: ["inferred", "imported"] },
        target: { type: "string" },
        reason: { type: "string" },
      },
      required: ["content", "origin"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_delete",
    description:
      "Soft-delete one record the user asked to remove: it moves to Ocean's trash and memory_restore brings it back. Needs the record's sha256 from memory_read as expectedHash.",
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        expectedHash: { type: "string" },
      },
      required: ["path", "expectedHash"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_restore",
    description:
      "Put back the content a memory_history entry preserved (a deleted record, or the version an update or restore replaced). When the record exists, pass its current sha256 as expectedHash.",
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, expectedHash: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "ocean_context",
    description:
      "Call this once at the start of a conversation when no Ocean start line is already in your context (clients without a session-start hook). Returns the bounded Ocean start line (256 bytes or less: the project bound to cwd and the operations available). Holds no records; search for those.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "ocean_projects_list",
    description: "List the user's Ocean projects (id and name only).",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "ocean_handoff_create",
    description:
      "Create a cross-client session handoff, only when the user explicitly asks for one: a short summary and the next action (4 KB at most in total; secrets are redacted). It always creates a new handoff and never changes an existing one; another client reads it with ocean_handoffs_list and ocean_handoff_get.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        nextAction: { type: "string" },
        title: { type: "string" },
        taskId: { type: "string" },
        project: { type: "string" },
      },
      required: ["summary", "nextAction"],
      additionalProperties: false,
    },
  },
]);

// What one MCP handoff may hold, summed over its texts (T-307).
export const HANDOFF_MAX_BYTES = 4096;

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
  // The query embedder for brain_search; null (or absent) searches by full text only.
  embedder?: () => Promise<EmbedderPort | null>;
};

function textResult(value: unknown): {
  content: [{ type: "text"; text: string }];
  structuredContent: unknown;
} {
  // A string result (ocean_context) is sent as is, so its byte budget holds on the wire.
  if (typeof value === "string")
    return {
      content: [{ type: "text", text: value }],
      structuredContent: { text: value },
    };
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

const MUTATING_TOOLS = new Set([
  "memory_write",
  "memory_propose",
  "memory_delete",
  "memory_restore",
]);

// The connected client's name from `initialize` (one stdio server per client), recorded as the
// source of every memory change it makes.
let clientName = "unknown";

async function callTool(
  name: string,
  args: Record<string, unknown>,
  ports: OceanMcpPorts,
): Promise<unknown> {
  if (name === "ocean_status")
    return {
      name: "Ocean",
      version: await serverVersion(),
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
      embedder: ports.embedder ? await ports.embedder() : null,
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
  if (name === "ocean_ping") return { ok: true };
  if (name === "ocean_capabilities")
    return {
      contract: MEMORY_CONTRACT_VERSION,
      tools: tools.list().map((tool) => tool.name),
      writes: (await memorySettings()).mcpWrites,
    };
  if (name === "ocean_context")
    return oceanContext(
      typeof args.cwd === "string" && args.cwd ? args.cwd : process.cwd(),
    );
  if (name === "ocean_projects_list")
    return {
      projects: (await scanProjectManifests()).manifests
        .map((project) => ({ id: project.id, name: project.name }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
  if (name === "ocean_handoff_create") return createClientHandoff(args, ports);
  if (name === "memory_read")
    return readMemoryRecord(requiredArgument(args, "path"));
  if (name === "memory_history")
    return memoryHistory({
      path: typeof args.path === "string" ? args.path : undefined,
      limit: typeof args.limit === "number" ? args.limit : undefined,
    });
  if (MUTATING_TOOLS.has(name) && !(await memorySettings()).mcpWrites)
    throw new MemoryContractError(
      "WRITES_OFF",
      "memory writes over MCP are off (bridge/config/memory.json)",
    );
  const source = clientName;
  const text = (key: string) =>
    typeof args[key] === "string" ? (args[key] as string) : undefined;
  if (name === "memory_write")
    return writeMemoryRecord({
      path: requiredArgument(args, "path"),
      content: requiredArgument(args, "content"),
      mode: args.mode as "create" | "update",
      expectedHash: text("expectedHash"),
      allowSimilar: args.allowSimilar === true,
      source,
    });
  if (name === "memory_propose")
    return proposeMemory({
      content: requiredArgument(args, "content"),
      origin: args.origin as "inferred" | "imported",
      target: text("target"),
      reason: text("reason"),
      source,
    });
  if (name === "memory_delete")
    return deleteMemoryRecord({
      path: requiredArgument(args, "path"),
      expectedHash: requiredArgument(args, "expectedHash"),
      source,
    });
  if (name === "memory_restore")
    return restoreMemory({
      id: requiredArgument(args, "id"),
      expectedHash: text("expectedHash"),
      source,
    });
  throw new Error(`Unknown MCP tool: ${name}`);
}

// A handoff a client writes on the user's request: bounded, redacted, always a new record.
async function createClientHandoff(
  args: Record<string, unknown>,
  ports: OceanMcpPorts,
): Promise<unknown> {
  const text = (key: string) =>
    typeof args[key] === "string" ? (args[key] as string).trim() : "";
  const summary = requiredArgument(args, "summary");
  const nextAction = requiredArgument(args, "nextAction");
  const title = text("title");
  const bytes = [summary, nextAction, title].reduce(
    (sum, item) => sum + Buffer.byteLength(item, "utf8"),
    0,
  );
  if (bytes > HANDOFF_MAX_BYTES)
    throw new Error(
      `handoff is ${bytes} bytes; the limit is ${HANDOFF_MAX_BYTES} — shorten the summary`,
    );
  const project = text("project");
  if (project && !isValidProjectId(project))
    throw new Error(`invalid project id '${project}'`);
  const clean = (value: string) => redactSecrets(value);
  const task = text("taskId")
    ? await getTask(text("taskId"), {
        projectId: project || undefined,
        explicit: Boolean(project),
      })
    : null;
  const handoff = await createHandoff(
    {
      task,
      title: title ? clean(title) : undefined,
      content: clean(summary),
      nextAction: clean(nextAction),
      provider: clientName,
      projectId: project || undefined,
    },
    ports.sessionStoreFactory,
  );
  return {
    handoffId: handoff.handoffId,
    taskId: handoff.taskId,
    projectId: handoff.projectId,
    provider: handoff.provider,
    redacted: [summary, nextAction, title].some((item) => clean(item) !== item),
  };
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
      version: await serverVersion(),
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
  if (request.method === "initialize") {
    const info = request.params?.clientInfo as { name?: unknown } | undefined;
    if (typeof info?.name === "string" && /^[\w .@/-]{1,64}$/.test(info.name))
      clientName = info.name;
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "ocean", version: await serverVersion() },
        instructions: MEMORY_INSTRUCTIONS,
      },
    };
  }
  if (request.method === "tools/list")
    return { jsonrpc: "2.0", id: request.id, result: { tools: tools.list() } };
  if (request.method === "resources/list")
    return { jsonrpc: "2.0", id: request.id, result: { resources } };
  if (request.method === "resources/read") {
    try {
      const contents = [
        await readResource(String(request.params?.uri ?? ""), ports),
      ];
      await recordMcpCall(clientName, "resources/read", true);
      return { jsonrpc: "2.0", id: request.id, result: { contents } };
    } catch (error) {
      await recordMcpCall(clientName, "resources/read", false);
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
      const result = await getPrompt(
        String(request.params?.name ?? ""),
        (request.params?.arguments ?? {}) as Record<string, unknown>,
      );
      await recordMcpCall(clientName, "prompts/get", true);
      return { jsonrpc: "2.0", id: request.id, result };
    } catch (error) {
      await recordMcpCall(clientName, "prompts/get", false);
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
  if (typeof name !== "string" || !tools.has(name)) {
    // The requested name is caller text, so it is not what gets logged.
    await recordMcpCall(clientName, "unknown", false);
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32602, message: "Unknown MCP tool" },
    };
  }
  try {
    const result = textResult(
      await callTool(
        name,
        (request.params?.arguments ?? {}) as Record<string, unknown>,
        ports,
      ),
    );
    await recordMcpCall(clientName, name, true);
    return { jsonrpc: "2.0", id: request.id, result };
  } catch (error) {
    await recordMcpCall(clientName, name, false);
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof MemoryContractError
          ? { data: { code: error.code, ...error.details } }
          : {}),
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
