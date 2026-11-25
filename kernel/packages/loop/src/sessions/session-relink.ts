import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { factTarget } from "@ocean/brain/memory/fact-routing.js";
import type { SessionStorePort } from "@ocean/core/domain/ports/session-store-port.js";
import {
  PROJECT_IDENTITY_EVENT,
  type ProjectConfidence,
  type ProjectHow,
  sessionIdentity,
} from "@ocean/core/domain/sessions/session-identity.js";
import {
  metadataLines,
  readMetadata,
  type SessionActivity,
} from "@ocean/core/domain/sessions/session-metadata.js";
import {
  atomicWrite,
  parseFrontmatter,
  safeJsonParse,
} from "@ocean/core/shared/fs-utils.js";
import {
  DAILY_DIR,
  INBOX_DIR,
  oceanPath,
  oceanRoot,
  SYSTEM_DIR,
} from "@ocean/core/shared/paths.js";
import {
  type ClaudeConversation,
  listProjectManifests,
  matchProject,
  type ProjectManifest,
  readClaudeConversations,
} from "@ocean/core/shared/project-resolution.js";
import {
  type SessionEndClient,
  TRANSCRIPT_CLIENTS,
} from "../hooks/session-end-hook.js";
import {
  FACTS_CLAIM_EVENT,
  readTranscriptSlice,
  recordActivity,
  transcriptStart,
} from "../hooks/session-facts-hook.js";

// `ocean sessions relink` (T-337): old session records brought to what a new session writes —
// the project from the store (or the Desktop conversation's Claude project), never a folder
// name; real times and counts from the kept transcript; the Desktop title and Claude project.
// Only frontmatter changes, and only values that can be derived; nothing is invented. Old
// review candidates whose project now resolves get that project's memory/ as their target.

export type FieldChange = { key: string; from: string; to: string };

export type RelinkChange = {
  // Workspace-relative path.
  file: string;
  kind: "record" | "candidate";
  changes: FieldChange[];
  before: string;
  after: string;
};

export type RelinkPlan = { scanned: number; changes: RelinkChange[] };

// The keys relink owns. Every other frontmatter line is left as it was.
const HEAD_KEYS = ["project", "task"];
const BLOCK_KEYS = [
  "conversation_title",
  "claude_project",
  "project_how",
  "project_confidence",
  "branch",
  "started",
  "ended",
  "duration_min",
  "turns_user",
  "turns_assistant",
  "tools",
  "files",
  "model",
  "extraction",
];

const MAX_WHOLE_TRANSCRIPT = 4 * 1024 * 1024;

const quote = (value: string) => JSON.stringify(value);
const tidy = (value: string, max = 200) =>
  value.replace(/\s+/g, " ").trim().slice(0, max);

async function markdownIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownIn(file)));
    else if (entry.name.endsWith(".md")) files.push(file);
  }
  return files;
}

const relative = (file: string) =>
  path.relative(oceanRoot(), file).split(path.sep).join("/");

function splitFrontmatter(
  text: string,
): { head: string[]; rest: string } | null {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  return {
    head: text.slice(4, end).split("\n"),
    rest: text.slice(end + 1),
  };
}

const lineKey = (line: string) => /^([A-Za-z_][\w-]*):/.exec(line)?.[1];

// The record's frontmatter with relink's keys replaced: project and task after `type:`, the
// rest after `session_id:`, so a record written twice comes out the same.
function rewriteRecord(
  text: string,
  head: string[],
  block: string[],
): string | null {
  const parts = splitFrontmatter(text);
  if (!parts) return null;
  const owned = new Set([...HEAD_KEYS, ...BLOCK_KEYS]);
  const kept = parts.head.filter((line) => {
    const key = lineKey(line);
    return !key || !owned.has(key);
  });
  const out: string[] = [];
  for (const line of kept) {
    out.push(line);
    if (lineKey(line) === "type") out.push(...head);
    if (lineKey(line) === "session_id") out.push(...block);
  }
  return `---\n${out.join("\n")}\n${parts.rest}`;
}

// Frontmatter fields with a quoted value decoded as the JSON string it was written as, so a
// value with escapes reads back the same as it was written.
function readFields(text: string): Record<string, string> {
  const fields = parseFrontmatter(text);
  for (const line of splitFrontmatter(text)?.head ?? []) {
    const match = /^([A-Za-z_][\w-]*): (".*")$/.exec(line);
    if (!match) continue;
    try {
      const value = JSON.parse(match[2]) as unknown;
      if (typeof value === "string") fields[match[1]] = value;
    } catch {
      /* kept as parseFrontmatter read it */
    }
  }
  return fields;
}

function fieldChanges(before: string, after: string): FieldChange[] {
  const a = readFields(before);
  const b = readFields(after);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys
    .filter((key) => (a[key] ?? "") !== (b[key] ?? ""))
    .map((key) => ({ key, from: a[key] ?? "", to: b[key] ?? "" }));
}

// The newest transcript the store saw this session claimed from.
function transcriptOf(events: { type: string; data: string }[]): string {
  let found = "";
  for (const event of events) {
    if (event.type !== FACTS_CLAIM_EVENT) continue;
    const claim = safeJsonParse(event.data);
    if (typeof claim?.transcript === "string") found = claim.transcript;
  }
  return found;
}

type Transcript = {
  started?: string;
  ended?: string;
  activity?: SessionActivity;
};

async function readTranscript(
  file: string,
  client: SessionEndClient,
  cwd: string | undefined,
): Promise<Transcript> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return {};
  }
  const started = await transcriptStart(file);
  const slice = await readTranscriptSlice(file, client, 0);
  const ended =
    slice.last && started && slice.last < started ? started : slice.last;
  return {
    ...((started ?? slice.first) ? { started: started ?? slice.first } : {}),
    ...(ended ? { ended } : {}),
    // Counts only from a transcript read whole: a tail would undercount.
    ...(size <= MAX_WHOLE_TRANSCRIPT && slice.activity
      ? { activity: recordActivity(slice.activity, slice.cwd ?? cwd) }
      : {}),
  };
}

type Decision = {
  project: string;
  task: string;
  how: ProjectHow;
  confidence: ProjectConfidence;
};

async function planRecord(
  file: string,
  text: string,
  context: {
    store: SessionStorePort;
    manifests: ProjectManifest[];
    conversations: Record<string, ClaudeConversation>;
  },
): Promise<RelinkChange | null> {
  const fields = readFields(text);
  if (fields.type !== "session" || !fields.session_id) return null;
  const known = (value: string | null | undefined) =>
    value ? (matchProject(context.manifests, value) ?? "") : "";
  const before = readMetadata(fields);
  const current = {
    project: known(fields.project),
    how: (fields.project_how as ProjectHow | undefined) ?? undefined,
    confidence:
      (fields.project_confidence as ProjectConfidence | undefined) ?? undefined,
  };
  // Kept unless something better is derived.
  const keep = (project: string): Decision => ({
    project,
    task: fields.task ?? "",
    ...(project && current.how && project === fields.project
      ? { how: current.how, confidence: current.confidence ?? "medium" }
      : project
        ? { how: "backfill" as const, confidence: "medium" as const }
        : { how: "none" as const, confidence: "none" as const }),
  });

  let decision: Decision;
  let title = fields.conversation_title ?? "";
  let claudeProject = fields.claude_project ?? "";
  let times: Transcript = {};

  const uuid = /^desktop:(.+)$/.exec(fields.session_id)?.[1];
  if (fields.provider === "claude-desktop" && uuid) {
    const conversation = context.conversations[uuid];
    if (conversation?.title) title = tidy(conversation.title);
    if (conversation?.projectName)
      claudeProject = tidy(conversation.projectName);
    const linked = known(claudeProject);
    decision = linked
      ? {
          project: linked,
          task: fields.task ?? "",
          how: "claude-project",
          confidence: "high",
        }
      : keep(current.project);
  } else {
    const row = context.store.get(fields.session_id);
    const events = row ? context.store.listEvents(fields.session_id) : [];
    const identity = row ? sessionIdentity(row, events) : null;
    const fromStore = known(identity?.projectId);
    const recorded = events.some(
      (event) =>
        event.type === PROJECT_IDENTITY_EVENT &&
        safeJsonParse(event.data)?.projectId === identity?.projectId,
    );
    const project = fromStore || current.project;
    decision = {
      ...(identity && recorded && fromStore
        ? { project, how: identity.how, confidence: identity.confidence }
        : keep(project)),
      task: identity?.taskId || fields.task || "",
    };
    const client = fields.provider as SessionEndClient;
    const transcript = transcriptOf(events);
    if (transcript && TRANSCRIPT_CLIENTS.includes(client))
      times = await readTranscript(
        transcript,
        client,
        row?.workingDirectory ?? undefined,
      );
  }

  const started = times.started ?? before.started;
  const ended = times.ended ?? before.ended;
  const activity = before.activity ?? times.activity;
  const block = [
    ...(title ? [`conversation_title: ${quote(title)}`] : []),
    ...(claudeProject ? [`claude_project: ${quote(claudeProject)}`] : []),
    ...metadataLines({
      projectHow: decision.how,
      projectConfidence: decision.confidence,
      ...(before.branch ? { branch: before.branch } : {}),
      ...(started ? { started } : {}),
      ...(ended ? { ended } : {}),
      ...(activity ? { activity } : {}),
      ...(before.extraction ? { extraction: before.extraction } : {}),
    }),
  ];
  const after = rewriteRecord(
    text,
    [`project: ${quote(decision.project)}`, `task: ${quote(decision.task)}`],
    block,
  );
  if (!after) return null;
  const changes = fieldChanges(text, after);
  return changes.length
    ? { file: relative(file), kind: "record", changes, before: text, after }
    : null;
}

// A pending project fact that was proposed with no target because its project was unknown
// then, and is known now.
async function planCandidate(
  file: string,
  text: string,
): Promise<RelinkChange | null> {
  const fields = readFields(text);
  if (fields.type !== "project" || fields.target || !fields.project)
    return null;
  const body = splitFrontmatter(text)?.rest ?? "";
  const title = /^# (.+)$/m.exec(body)?.[1]?.trim() ?? "";
  if (!title) return null;
  const target = await factTarget({
    type: "project",
    title,
    project: fields.project,
  });
  if (!target) return null;
  const after = text.replace(/^target: .*$/m, `target: ${quote(target)}`);
  if (after === text) return null;
  return {
    file: relative(file),
    kind: "candidate",
    changes: fieldChanges(text, after),
    before: text,
    after,
  };
}

export async function planRelink(store: SessionStorePort): Promise<RelinkPlan> {
  const context = {
    store,
    manifests: await listProjectManifests(),
    conversations: await readClaudeConversations(),
  };
  const changes: RelinkChange[] = [];
  let scanned = 0;
  for (const file of await markdownIn(oceanPath(DAILY_DIR, "sessions"))) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (!/^type: session$/m.test(text.slice(0, 4096))) continue;
    scanned++;
    const change = await planRecord(file, text, context);
    if (change) changes.push(change);
  }
  for (const file of await markdownIn(oceanPath(INBOX_DIR, "candidates"))) {
    const text = await readFile(file, "utf8").catch(() => "");
    scanned++;
    const change = await planCandidate(file, text);
    if (change) changes.push(change);
  }
  return { scanned, changes };
}

// Writes the plan: every file is copied, at its workspace path, under one backup folder first.
// A file that changed since it was planned is left alone and reported.
export async function applyRelink(
  plan: RelinkPlan,
  now = new Date(),
): Promise<{ written: string[]; stale: string[]; backup: string }> {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const backup = oceanPath(SYSTEM_DIR, "state", "backups", `relink-${stamp}`);
  const written: string[] = [];
  const stale: string[] = [];
  for (const change of plan.changes) {
    const file = oceanPath(change.file);
    if ((await readFile(file, "utf8").catch(() => "")) !== change.before) {
      stale.push(change.file);
      continue;
    }
    const copy = path.join(backup, change.file);
    await mkdir(path.dirname(copy), { recursive: true, mode: 0o700 });
    await copyFile(file, copy);
    await atomicWrite(file, change.after);
    written.push(change.file);
  }
  return { written, stale, backup: relative(backup) };
}
