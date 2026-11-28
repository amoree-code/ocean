import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "./fs-utils.js";
import { oceanPath, SYSTEM_DIR } from "./paths.js";

// Ocean MCP tool groups (T-339 P2). Eight core tools are listed to every client; every other
// tool sits in a group opened by the conversation (the prompt hook matches a group's triggers),
// by the session's profile (`tools:`), or by `ocean_tools`. A tool off the list still answers
// `tools/call`, and `ocean_call` runs one by name for a client that refuses unlisted names.

export const CORE_TOOLS = [
  "brain_search",
  "brain_read",
  "memory_read",
  "memory_write",
  "memory_propose",
  "ocean_context",
  "ocean_tools",
  "ocean_call",
] as const;

export type ToolGroup = { tools: string[]; triggers: string[] };

export const TOOL_GROUPS: Record<string, ToolGroup> = {
  "memory-admin": {
    tools: ["memory_delete", "memory_history", "memory_restore"],
    triggers: [
      "delete memory",
      "forget",
      "memory history",
      "restore memory",
      "undo memory",
      "انسى",
      "امسح الذاكره",
      "رجع الذاكره",
    ],
  },
  "brain-extra": {
    tools: ["brain_neighbors"],
    triggers: [
      "related notes",
      "neighbors",
      "linked notes",
      "backlinks",
      "مرتبط",
    ],
  },
  sessions: {
    tools: [
      "ocean_session_get",
      "ocean_session_events",
      "ocean_session_summary",
      "ocean_session_save",
      "ocean_session_promote",
    ],
    triggers: [
      "session",
      "last session",
      "save session",
      "transcript",
      "الجلسه",
      "جلسه",
      "احفظ",
    ],
  },
  handoffs: {
    tools: ["ocean_handoff_create", "ocean_handoff_get", "ocean_handoffs_list"],
    triggers: ["handoff", "hand off", "continue in", "تسليم", "سلم"],
  },
  tasks: {
    tools: ["ocean_tasks_list", "ocean_task_get"],
    triggers: [
      "task",
      "tasks",
      "ticket",
      "backlog",
      "todo",
      "تاسك",
      "مهمه",
      "مهام",
      "تكت",
    ],
  },
  projects: {
    tools: ["ocean_projects_list", "ocean_project_link"],
    triggers: [
      "project",
      "projects",
      "link folder",
      "register",
      "مشروع",
      "مشاريع",
    ],
  },
  profiles: {
    tools: ["ocean_profiles_list", "ocean_profile_get"],
    triggers: ["profile", "profiles", "بروفايل", "الملف الشخصي"],
  },
  ops: {
    tools: ["ocean_doctor", "ocean_status", "ocean_ping", "ocean_capabilities"],
    triggers: [
      "doctor",
      "ocean status",
      "health check",
      "ping",
      "capabilities",
      "restart ocean",
      "صحه",
      "حاله اوشن",
    ],
  },
  people: {
    tools: ["people_lookup"],
    triggers: ["who is", "colleague", "teammate", "person", "منو", "زميل"],
  },
  skills: {
    tools: ["ocean_chat_skill"],
    triggers: ["chat skill", "install skill", "سكل"],
  },
  // Kept callable for saved instructions; `ocean_context` with `policy` replaces it.
  rules: { tools: ["ocean_policy"], triggers: [] },
};

export const GROUP_NAMES = Object.keys(TOOL_GROUPS);

// The groups a profile opens. `ocean-ops` opens ops and what it maintains.
export const PROFILE_DEFAULT_GROUPS: Record<string, string[]> = {
  "ocean-ops": [
    "ops",
    "profiles",
    "projects",
    "sessions",
    "handoffs",
    "skills",
  ],
};

export function groupOf(tool: string): string | null {
  for (const [name, group] of Object.entries(TOOL_GROUPS))
    if (group.tools.includes(tool)) return name;
  return null;
}

// ── The selection the hook writes and the servers follow (plan §2.3) ─────────────────────────
// Keyed by folder: an MCP server knows its cwd, not the client's session id. Two sessions in one
// folder share the file; groups are only ever added within a day, so a server shows the union.

export type ToolSelection = {
  version: 1;
  cwd: string;
  updatedAt: number;
  primary: string;
  secondary: string[];
  groups: string[];
};

const SELECTION_TTL_MS = 24 * 60 * 60 * 1000;

// One key per folder however it is spelled: the hook and the server may see a symlinked path,
// or (Windows) an 8.3 short name or another letter case, for the same folder.
export function selectionKey(cwd: string): string {
  let folder = path.resolve(cwd);
  try {
    folder = realpathSync.native(folder);
  } catch {
    // Not there yet: hash the resolved spelling.
  }
  if (process.platform === "win32") folder = folder.toLowerCase();
  return createHash("sha256").update(folder).digest("hex").slice(0, 16);
}

export function selectionPath(cwd: string): string {
  return oceanPath(
    SYSTEM_DIR,
    "state",
    "profiles",
    "current",
    `${selectionKey(cwd)}.json`,
  );
}

export async function readToolSelection(
  cwd: string,
): Promise<ToolSelection | null> {
  try {
    const parsed = JSON.parse(await readFile(selectionPath(cwd), "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.groups)) return null;
    return parsed as ToolSelection;
  } catch {
    return null;
  }
}

// Merges into what is there (union of groups and secondaries) unless the file is a day old.
// Returns the written selection, or null when nothing changed.
export async function writeToolSelection(
  cwd: string,
  next: Omit<ToolSelection, "version" | "cwd" | "updatedAt">,
  now = Date.now(),
): Promise<ToolSelection | null> {
  const current = await readToolSelection(cwd);
  const fresh = current && now - current.updatedAt < SELECTION_TTL_MS;
  const groups = [
    ...new Set([...(fresh ? current.groups : []), ...next.groups]),
  ]
    .filter((name) => name in TOOL_GROUPS)
    .sort();
  const secondary = [
    ...new Set([...(fresh ? current.secondary : []), ...next.secondary]),
  ].sort();
  if (
    fresh &&
    current.primary === next.primary &&
    current.groups.join() === groups.join() &&
    current.secondary.join() === secondary.join()
  )
    return null;
  const selection: ToolSelection = {
    version: 1,
    cwd: path.resolve(cwd),
    updatedAt: now,
    primary: next.primary,
    secondary,
    groups,
  };
  const file = selectionPath(cwd);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWrite(file, `${JSON.stringify(selection, null, 2)}\n`);
  return selection;
}

// T-339 P2 (plan §2.5): whether a client re-lists on `notifications/tools/list_changed` (layer 2)
// or must reach a newly opened tool through `ocean_call` (layer 3). Keyed by the MCP
// `clientInfo.name` it sends at initialize. Every value comes from an `ocean mcp probe-client`
// run (docs: client-matrix.md); a client missing here has not been probed yet.
export const CLIENT_RELISTS: Record<string, boolean> = {
  "codex-mcp-client": false, // Codex 0.156.1, 2026-11-28
  "gemini-cli-mcp-client": true, // Gemini CLI 0.61.0, 2026-11-28
  Cursor: false, // cursor-agent (clientInfo 1.0.0), 2026-11-28
  // Hermes 0.19.0 sends the Python SDK default name. It re-lists, but `hermes -z` keeps the
  // model's tool list fixed for the turn, so an opened tool is not callable until later.
  mcp: false, // 2026-11-28
};

export function clientRelists(
  clientName: string | undefined,
): boolean | undefined {
  return clientName === undefined ? undefined : CLIENT_RELISTS[clientName];
}
