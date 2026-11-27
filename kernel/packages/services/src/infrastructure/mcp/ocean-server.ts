import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  brainNeighbors,
  brainRead,
  brainSearch,
} from "@ocean/brain/brain/brain-service.js";
import { memorySettings } from "@ocean/brain/memory/memory-audit.js";
import {
  fileProposal,
  type ProposalKind,
} from "@ocean/brain/memory/memory-review.js";
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
import { lookupPerson } from "@ocean/brain/memory/people.js";
import { promoteSessionToKnowledge } from "@ocean/brain/memory/session-promotion.js";
import { isValidProjectId } from "@ocean/core/domain/context/project-id.js";
import type { McpTool } from "@ocean/core/domain/mcp/mcp-contract.js";
import {
  actionFingerprint,
  mcpApprovalSchema,
} from "@ocean/core/domain/mcp/mcp-contract.js";
import {
  MEMORY_AUTHORITY_LINE,
  MEMORY_CONTRACT_VERSION,
  MEMORY_INSTRUCTIONS,
  MemoryContractError,
} from "@ocean/core/domain/mcp/memory-contract.js";
import type { BrainIndexPort } from "@ocean/core/domain/ports/brain-index-port.js";
import type { EmbedderPort } from "@ocean/core/domain/ports/embedder-port.js";
import type { WrapperManagerPort } from "@ocean/core/domain/ports/platform-ports.js";
import type { SessionStoreFactory } from "@ocean/core/domain/ports/session-store-port.js";
import { redactSecrets } from "@ocean/core/domain/redaction/redaction.js";
import { readRules } from "@ocean/core/shared/charter.js";
import { ackIssued } from "@ocean/core/shared/context-ack.js";
import {
  enginePath,
  oceanPath,
  oceanRoot,
  SYSTEM_DIR,
} from "@ocean/core/shared/paths.js";
import {
  findProject,
  folderProject,
  listProjectManifests,
  registerNamedProject,
  resolveProject,
  scanProjectManifests,
  suggestProjects,
} from "@ocean/core/shared/project-resolution.js";
import {
  profileBundle,
  profileCatalog,
  sessionProfile,
} from "@ocean/core/shared/session-profile.js";
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
import type { McpSessionRecorder } from "./mcp-session.js";
import { installedVersion, serverVersion } from "./server-version.js";
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

// Ocean's tools come in two groups (T-338 P5, plan §3.4). Core is listed to every client; ops —
// maintenance of Ocean itself — is listed only when the session's profile is `ocean-ops`, after
// `ocean_profile_get` names it, or with OCEAN_MCP_TOOLS=all. A tool left off the list still
// answers `tools/call`, so self-checks and saved instructions that name one keep working.
export const OCEAN_OPS_TOOLS = new Set([
  "ocean_profiles_list",
  "ocean_session_get",
  "ocean_session_summary",
  "ocean_session_events",
  "ocean_session_promote",
  "ocean_handoffs_list",
  "ocean_handoff_get",
  "ocean_project_link",
  "ocean_projects_list",
  "ocean_chat_skill",
  "ocean_doctor",
  "ocean_ping",
  "ocean_capabilities",
]);
const OPS_PROFILE = "ocean-ops";
// undefined until the first tools/list resolves it from the session's folder.
let opsListed: boolean | undefined;
// Writes a server-initiated message (a list_changed notification) to the client, when one is open.
let notifyClient: ((message: Record<string, unknown>) => void) | undefined;

async function resolveOpsListed(cwd: string): Promise<boolean> {
  if (process.env.OCEAN_MCP_TOOLS === "all") return true;
  // Desktop launches at the filesystem root: no project, so the base profile.
  if (cwd === "/" || /^[A-Za-z]:\\?$/.test(cwd)) return false;
  try {
    const catalog = await profileCatalog();
    const project = await resolveProject(cwd).catch(() => undefined);
    const session = await sessionProfile({
      projectId: project?.status === "bound" ? project.projectId : undefined,
      cwd,
      catalog,
    });
    return [session.primary, ...session.secondary].includes(OPS_PROFILE);
  } catch {
    return false;
  }
}

async function listedTools(): Promise<McpTool[]> {
  opsListed ??= await resolveOpsListed(process.cwd());
  return opsListed
    ? tools.list()
    : tools.list().filter((tool) => !OCEAN_OPS_TOOLS.has(tool.name));
}

// Every tool takes an optional contextAck: the ack=<hash> from the Ocean start line, echoed on a
// client's first Ocean call (T-319 CONTEXT-ACK). The server takes it off before the tool runs.
function withContextAck(list: McpTool[]): McpTool[] {
  return list.map((tool) => {
    const schema = tool.inputSchema as
      | { properties?: Record<string, unknown> }
      | undefined;
    return {
      ...tool,
      inputSchema: {
        ...schema,
        properties: {
          ...schema?.properties,
          contextAck: {
            type: "string",
            description: "Start-line ack; first call only.",
          },
        },
      },
    };
  });
}

// The seconds the background capture waits first, so the app has written the turn that asked
// for the save to its local store before it is read.
export const DESKTOP_SAVE_WAIT_SECONDS = 20;

// A detached `ocean desktop …` run, so a model call or a wait never holds the tool call open.
function startDesktop(args: string[]): boolean {
  try {
    spawn(process.execPath, [process.argv[1] ?? "", "desktop", ...args], {
      detached: true,
      stdio: "ignore",
    })
      .on("error", () => {})
      .unref();
    return true;
  } catch {
    return false;
  }
}

// The project a tool argument names (T-333). A name no project answers to is refused with the
// projects it probably means, never guessed.
async function toolProject(ref: string): Promise<string> {
  const manifests = await listProjectManifests();
  const id = await findProject(ref);
  if (id) return id;
  const near = [
    ...new Set(suggestProjects(manifests, ref).map((each) => each.id)),
  ];
  throw new Error(
    `no project answers to '${ref}'${near.length ? `; did you mean ${near.join(", ")}?` : ""} (ocean_projects_list lists them)`,
  );
}

// `ocean_session_save` (T-329): the capture is a model call, longer than a tool call should
// take, so it runs as its own detached `ocean desktop capture --latest`, like SessionEnd's. A
// project passed in binds the chat there first (T-333): explicit wins.
async function startDesktopSave(
  args: Record<string, unknown>,
): Promise<{ status: string; message: string; project?: string }> {
  const project =
    typeof args.project === "string" && args.project.trim()
      ? await toolProject(args.project.trim())
      : undefined;
  const started = startDesktop([
    "capture",
    "--latest",
    ...(project ? ["--project", project] : []),
    "--wait",
    String(DESKTOP_SAVE_WAIT_SECONDS),
  ]);
  if (!started)
    return {
      status: "failed",
      message:
        "The capture could not start. The conversation is still captured once it has been quiet for two hours.",
    };
  return {
    status: "started",
    ...(project ? { project } : {}),
    message:
      "Saving this conversation to Ocean in the background. Its session record appears in sessions/ within a few minutes.",
  };
}

// `ocean_project_link` (T-333): this Desktop chat, and the Claude project it sits in, belong to
// an Ocean project from now on. The project is found (or registered) now; the binding waits in
// the background until the app has written this chat to its store.
async function linkDesktopProject(args: Record<string, unknown>): Promise<{
  status: string;
  project: string;
  created: boolean;
  message: string;
}> {
  const ref = typeof args.project === "string" ? args.project.trim() : "";
  const name = typeof args.name === "string" ? args.name.trim() : "";
  let project: string;
  let created = false;
  if (ref) project = await toolProject(ref);
  else if (name && args.create === true)
    ({ id: project, created } = await registerNamedProject(name, [
      "claude.ai",
    ]));
  else if (name) project = await toolProject(name);
  else
    throw new Error("pass project, or name (with create: true for a new one)");
  const started = startDesktop([
    "link",
    project,
    "--wait",
    String(DESKTOP_SAVE_WAIT_SECONDS),
  ]);
  return {
    status: started ? "started" : "failed",
    project,
    created,
    message: started
      ? `This chat and its Claude project are being linked to '${project}' in the background.`
      : `The link could not start; run: ocean desktop link ${project}`,
  };
}

const tools = new McpToolRegistry(
  withContextAck([
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
      description:
        "List the Ocean profiles (domain bundles of skills and tools): name, kind, description and the triggers that point at each. Call ocean_profile_get for one when the request is clearly another profile's domain.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "ocean_profile_get",
      description:
        "Read one Ocean profile's bundle (2 KB or less): its skills, gateway tools, connectors, Composio toolkits and instructions. Without name, the profile chosen for this session (the start line's profile=). Call it only when the one-line profile brief is not enough.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, cwd: { type: "string" } },
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
      name: "ocean_session_save",
      description:
        "Claude Desktop chat only: save this conversation to Ocean now, instead of waiting for it to close. Call it when the user says save, remember this conversation, or is about to leave. It starts a background capture of the most recently updated Desktop conversation (its session record, facts and raw transcript) and returns at once; the record lands in sessions/ within a few minutes. Pass project (an Ocean project id or name) when the conversation is about one project: it files the record there. Claude Code and CLI sessions are captured at session end and need no call.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: "object",
        properties: { project: { type: "string" } },
        additionalProperties: false,
      },
    },
    {
      name: "brain_search",
      description:
        "Call this first, before answering anything about the user or their world: a project, repo or code of theirs, a task ID, a person they name, a past decision or preference, or words like my, our, last time, as before. Also before planning, writing or reviewing anything for them. Ocean is their memory and the authority: asked where memory lives or what you remember, answer from Ocean, since this client's own memory is only a copy Ocean captures. Searches the markdown memory/knowledge index (hybrid FTS + vector when available); read only the results you need with brain_read and cite their paths. In a conversation about one project, pass its name or id as project: the search then covers that project and global records only. Otherwise the project bound to `cwd`; unbound sessions see global only.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
          types: { type: "array", items: { type: "string" } },
          since: {
            type: "string",
            description: "YYYY-MM-DD: only records dated on or after it",
          },
          asOf: {
            type: "string",
            description:
              "YYYY-MM-DD: only facts valid on that day (valid_from / superseded_by)",
          },
          task: {
            type: "string",
            description:
              'A task id: only session records whose metadata names it (with types ["session"])',
          },
          branch: {
            type: "string",
            description: "A git branch: only session records made on it",
          },
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
      description:
        "Walk the wikilink graph around one memory/knowledge record.",
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
        "Call this when the user states something worth keeping across sessions (a decision, preference, correction of how you work, or project fact) without asking you to remember it, for a fact you inferred, or for one imported from another tool's memory: it queues it for the user's review. It is not memory until approved. In a conversation about one project, pass its name (as the user's Claude project is called) or Ocean id as project, and kind instead of target: `fact` (a decision, preference or detail) or `doc` (a spec, brief or longer notes), each with a kebab-case name, is filed in that project's memory/ or docs/ — written at once when the user allows it; `todo` (work to do) waits for review as a backlog line. Optionally say why (reason). If the fact disagrees with one of the user's own notes in 02-personal/notes, pass that note's path as contradicts: the note is never edited, and the disagreement waits in 02-personal/CONFLICTS.md for the user.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string" },
          origin: { type: "string", enum: ["inferred", "imported"] },
          target: { type: "string" },
          project: { type: "string" },
          kind: { type: "string", enum: ["fact", "doc", "todo"] },
          name: { type: "string" },
          reason: { type: "string" },
          contradicts: { type: "string" },
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
        properties: {
          id: { type: "string" },
          expectedHash: { type: "string" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "ocean_context",
      description:
        "Call this once at the start of a conversation when no Ocean start line is already in your context (clients without a session-start hook). Returns the bounded Ocean start line (256 bytes or less: the project bound to cwd and the operations available) and, when the user has rules, which ocean_policy names hold them. Pass project (an Ocean project id or name) instead of cwd when the conversation is about one project, as in a Claude Desktop project: the line and the start brief are that project's. Holds no records; search for those.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: { cwd: { type: "string" }, project: { type: "string" } },
        additionalProperties: false,
      },
    },
    {
      name: "ocean_policy",
      description:
        'Read the user\'s own rules: name "core" (language, direction, working style) or a policy such as "response" (report shape). Call it when ocean_context names it, before your first substantial reply.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
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
      name: "ocean_project_link",
      description:
        "Claude Desktop chat only: link this conversation, and the Claude project it sits in, to an Ocean project, when the user says which project it belongs to. Pass project (an existing Ocean project id or name), or name with create: true to register a new project of that name. Its records, and the Claude project's later chats, are filed there from now on.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          name: { type: "string" },
          create: { type: "boolean" },
        },
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
    {
      name: "people_lookup",
      description:
        "Find a person the user knows by name, in English or Arabic: matches a file name, title or alias in 02-personal/people/ exactly (case and spacing ignored), never a part of a name. Returns each match's file, name, aliases, role, org, relation and last_seen; read the file with memory_read for the history.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
    },
    {
      name: "ocean_chat_skill",
      description:
        "Install Ocean's memory skill (ocean-memory) in the user's Claude account, so every Claude chat, Cowork and phone session asks Ocean before its own memory. Call when the user asks to install, set up, add or update Ocean or Ocean's skill in Claude, or says Claude chat is not using Ocean. Returns the skill file and how to hand it to the user to save.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ]),
);

// Ocean's memory skill for Claude chat (T-328). Nothing can add a skill to a Claude account
// for the user: no API, deep link or MCP call. Chat can propose the skill itself, though: Claude
// Desktop chat shows a skill card the user saves with one click (T-328, 2026-11-24), so the
// click stays inside the chat; a .skill file is the fallback.
export const CHAT_SKILL_DIR = "ocean-memory";

export async function chatSkillInstall(): Promise<{
  skill: string;
  file: string;
  content: string;
  steps: string[];
}> {
  const file = `${CHAT_SKILL_DIR}/SKILL.md`;
  return {
    skill: CHAT_SKILL_DIR,
    file,
    content: await readFile(
      enginePath("skills", "core", CHAT_SKILL_DIR, "SKILL.md"),
      "utf8",
    ),
    steps: [
      "If you can propose a skill for the user to save (a skill card), propose this one: name ocean-memory, content exactly as given, changing nothing. The user saves it from the card.",
      `Otherwise, with your code tool, write content to ${file} exactly as given, zip the ${CHAT_SKILL_DIR} folder (the folder itself, so the zip holds ${file}) as ${CHAT_SKILL_DIR}.skill, share that file, and tell the user to save it, or to upload it in Customize → Skills.`,
      "Without either, tell the user to run `ocean clients chat-plugin` on their computer: it saves ocean-memory.zip to upload in Customize → Skills.",
      "Skills need Settings → Capabilities → Code execution on.",
    ],
  };
}

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
  // A light session per connection for clients with no other session record (T-319).
  mcpSessions?: McpSessionRecorder;
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

async function profiles() {
  const catalog = await profileCatalog();
  return {
    profiles: catalog.profiles.map((profile) => ({
      name: profile.name,
      kind: profile.kind,
      description: profile.description,
      triggers: profile.triggers,
    })),
    ...(catalog.problems.length ? { problems: catalog.problems } : {}),
  };
}

// A named profile, or the one this session's project and folder resolve to (T-338 P2).
async function profileGet(name: string | undefined, cwd: string) {
  const catalog = await profileCatalog();
  let wanted = name;
  if (!wanted) {
    const project = await resolveProject(cwd).catch(() => null);
    wanted = (
      await sessionProfile({
        projectId: project?.status === "bound" ? project.projectId : undefined,
        cwd,
        catalog,
      })
    ).primary;
  }
  const profile = catalog.profiles.find(
    (candidate) => candidate.name === wanted,
  );
  if (!profile) {
    const problem = catalog.problems.find(
      (candidate) => candidate.name === wanted,
    );
    throw new Error(
      problem
        ? `profile ${wanted} does not load: ${problem.error}`
        : `no profile named ${wanted}; ocean_profiles_list names them`,
    );
  }
  return profileBundle(profile);
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
// Whether this connection's first tool call (ocean_context aside) has been checked for the
// start line's hash: one `context_ack` ledger line per connection, ok when it echoed a hash
// Ocean handed out.
let contextAckChecked = false;
// Hosts that drop `instructions` (Claude chat) still show tool results to the model, so the first
// memory result of each connection carries the authority line as a second text block (T-328).
let authoritySent = false;
const AUTHORITY_TOOLS = new Set(["brain_search", "brain_read", "memory_read"]);

async function callTool(
  name: string,
  args: Record<string, unknown>,
  ports: OceanMcpPorts,
): Promise<unknown> {
  if (name === "ocean_status") {
    const version = await serverVersion();
    const installed = await installedVersion();
    return {
      name: "Ocean",
      version,
      // A newer release installed since this server started: the client must restart it.
      installed,
      restartNeeded: version !== installed,
      workspace: oceanPath(),
      mcp: "stdio",
    };
  }
  if (name === "ocean_doctor") {
    const report = await workspaceReport(ports.wrapperManager);
    return {
      healthy: !hasFailures(report.findings),
      findings: report.findings,
    };
  }
  if (name === "ocean_profiles_list") return await profiles();
  if (name === "ocean_profile_get") {
    const wanted =
      typeof args.name === "string" && args.name.trim()
        ? args.name.trim()
        : undefined;
    // Naming ocean-ops opens its tools for the rest of this connection.
    if (wanted === OPS_PROFILE && opsListed !== true) {
      opsListed = true;
      notifyClient?.({
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
      });
    }
    return profileGet(
      wanted,
      typeof args.cwd === "string" && args.cwd ? args.cwd : process.cwd(),
    );
  }
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
  if (name === "ocean_session_save") return startDesktopSave(args);
  if (name === "ocean_project_link") return linkDesktopProject(args);
  if (name === "ocean_session_promote") {
    const approval = mcpApprovalSchema.parse(args.approval);
    const actionArgs = {
      sessionId: args.sessionId,
      target:
        typeof args.target === "string" ? args.target : "knowledge/lessons",
    };
    if (approval.fingerprint !== actionFingerprint(name, actionArgs))
      throw new Error(
        "Session promotion approval does not match the requested action",
      );
    return promoteSessionToKnowledge(
      requiredArgument(args, "sessionId"),
      ports.sessionStoreFactory,
      typeof args.target === "string" ? args.target : "knowledge/lessons",
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
      since: isoDay(args.since, "since"),
      asOf: isoDay(args.asOf, "asOf"),
      ...(typeof args.task === "string" && args.task.trim()
        ? { task: args.task }
        : {}),
      ...(typeof args.branch === "string" && args.branch.trim()
        ? { branch: args.branch }
        : {}),
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
  if (name === "ocean_chat_skill") return chatSkillInstall();
  if (name === "ocean_capabilities")
    return {
      contract: MEMORY_CONTRACT_VERSION,
      tools: tools.list().map((tool) => tool.name),
      writes: (await memorySettings()).mcpWrites,
    };
  if (name === "ocean_context")
    return oceanContext(
      typeof args.cwd === "string" && args.cwd ? args.cwd : process.cwd(),
      typeof args.project === "string" && args.project.trim()
        ? args.project.trim()
        : undefined,
    );
  if (name === "ocean_policy") return readRules(requiredArgument(args, "name"));
  if (name === "ocean_projects_list")
    return {
      projects: (await scanProjectManifests()).manifests
        .map((project) => ({ id: project.id, name: project.name }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
  if (name === "ocean_handoff_create") return createClientHandoff(args, ports);
  if (name === "people_lookup")
    return lookupPerson(requiredArgument(args, "name"));
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
  if (name === "memory_propose" && (text("project") || text("kind"))) {
    if (text("target"))
      throw new MemoryContractError(
        "INVALID",
        "pass target, or project and kind — not both",
      );
    return fileProposal({
      content: requiredArgument(args, "content"),
      origin: args.origin as "inferred" | "imported",
      project: requiredArgument(args, "project"),
      kind: requiredArgument(args, "kind") as ProposalKind,
      name: text("name"),
      reason: text("reason"),
      source,
    });
  }
  if (name === "memory_propose")
    return proposeMemory({
      content: requiredArgument(args, "content"),
      origin: args.origin as "inferred" | "imported",
      target: text("target"),
      reason: text("reason"),
      contradicts: text("contradicts"),
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
  // A project named by its id or its name (T-307: a Claude project's name finds its Ocean
  // project); a name Ocean does not know searches global records only.
  if (typeof args.project === "string" && args.project) {
    if (/[/\\]|\.\./.test(args.project))
      throw new Error(`invalid project id '${args.project}'`);
    const known = await findProject(args.project);
    if (known) return { project: known };
    if (!isValidProjectId(args.project)) return { project: null };
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

// An optional YYYY-MM-DD argument; anything else is refused rather than silently ignored.
function isoDay(value: unknown, key: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error(`${key} must be a YYYY-MM-DD date`);
  return value;
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
    contextAckChecked = false;
    authoritySent = false;
    opsListed = undefined;
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: {
          tools: { listChanged: true },
          resources: {},
          prompts: {},
        },
        // `name` is the machine id; `title` (MCP 2025-06-18) is the one display name every
        // client shows, under the one config key `ocean` → tool prefix `mcp__ocean__` (T-328).
        serverInfo: {
          name: "ocean",
          title: "Ocean",
          version: await serverVersion(),
        },
        instructions: MEMORY_INSTRUCTIONS,
      },
    };
  }
  if (request.method === "tools/list")
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: { tools: await listedTools() },
    };
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
  const { contextAck, ...args } = (request.params?.arguments ?? {}) as Record<
    string,
    unknown
  >;
  if (!contextAckChecked && name !== "ocean_context") {
    contextAckChecked = true;
    await recordMcpCall(clientName, "context_ack", await ackIssued(contextAck));
  }
  await ports.mcpSessions?.open(clientName);
  try {
    const result: {
      content: { type: "text"; text: string }[];
      structuredContent: unknown;
    } = textResult(await callTool(name, args, ports));
    if (!authoritySent && AUTHORITY_TOOLS.has(name)) {
      authoritySent = true;
      result.content.push({ type: "text", text: MEMORY_AUTHORITY_LINE });
    }
    await recordMcpCall(clientName, name, true);
    await ports.mcpSessions?.toolCall(clientName, name, true);
    return { jsonrpc: "2.0", id: request.id, result };
  } catch (error) {
    await recordMcpCall(clientName, name, false);
    await ports.mcpSessions?.toolCall(clientName, name, false);
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
  // Requests still being answered when stdin ends: the connection's session closes after them.
  const inFlight = new Set<Promise<void>>();
  notifyClient = (message) =>
    process.stdout.write(`${JSON.stringify(message)}\n`);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    const work = handleChunk(chunk);
    inFlight.add(work);
    work.finally(() => inFlight.delete(work)).catch(() => {});
  });
  async function handleChunk(chunk: string): Promise<void> {
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
  }
  await new Promise<void>((resolve) => process.stdin.once("end", resolve));
  await Promise.allSettled([...inFlight]);
  await ports.mcpSessions?.close();
}
