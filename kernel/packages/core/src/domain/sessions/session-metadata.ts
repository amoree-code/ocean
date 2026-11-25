import type { ProjectConfidence, ProjectHow } from "./session-identity.js";

// A session record's metadata block (T-334): how its project was decided and what the session
// did, counted from the transcript or the store, never asked of a model. Every key is bounded,
// and every value sits on one line (JSON is valid YAML), so the flat frontmatter reader reads it.

export const MAX_TOOLS = 5;
export const MAX_FILES = 8;
const NAME_CHARS = 60;
const PATH_CHARS = 160;
const TEXT_CHARS = 120;

export type SessionActivity = {
  turnsUser: number;
  // Assistant replies: the assistant's text between two user turns counts once.
  turnsAssistant?: number;
  tools: Record<string, number>;
  // Touches per path; the writer makes each path repo-relative.
  files: Record<string, number>;
  model?: string;
  branch?: string;
};

export type ExtractionCost = { model: string; inputChars: number; ms: number };

export type SessionMetadata = {
  projectHow: ProjectHow;
  projectConfidence: ProjectConfidence;
  branch?: string;
  started?: string;
  ended?: string;
  activity?: SessionActivity;
  extraction?: ExtractionCost;
};

const clip = (value: string, max: number) =>
  value.replace(/\s+/g, " ").trim().slice(0, max);

// The `limit` most-counted entries, ties by name, so the same counts always write the same block.
export function topCounts(
  counts: Record<string, number>,
  limit: number,
): [string, number][] {
  return Object.entries(counts)
    .filter(([name, count]) => name && count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

// Tool names as a person reads them: "mcp__ocean__brain_search" → "brain_search".
export function toolLabel(name: string): string {
  return clip(name.split("__").at(-1) || name, NAME_CHARS);
}

// Counts what a stretch of conversation did, one turn or tool call at a time.
export class ActivityTally {
  private readonly activity: SessionActivity = {
    turnsUser: 0,
    turnsAssistant: 0,
    tools: {},
    files: {},
  };
  private last: "user" | "assistant" | undefined;

  turn(role: "user" | "assistant"): void {
    if (role === "user") this.activity.turnsUser++;
    else if (this.last !== "assistant")
      this.activity.turnsAssistant = (this.activity.turnsAssistant ?? 0) + 1;
    this.last = role;
  }

  tool(name: string, file?: string): void {
    const label = toolLabel(name);
    if (label)
      this.activity.tools[label] = (this.activity.tools[label] ?? 0) + 1;
    if (file) this.activity.files[file] = (this.activity.files[file] ?? 0) + 1;
  }

  model(name: unknown): void {
    if (typeof name === "string" && name && !name.startsWith("<"))
      this.activity.model = clip(name, TEXT_CHARS);
  }

  branch(name: unknown): void {
    if (typeof name === "string" && name)
      this.activity.branch = clip(name, TEXT_CHARS);
  }

  result(): SessionActivity {
    return {
      ...this.activity,
      tools: { ...this.activity.tools },
      files: { ...this.activity.files },
    };
  }
}

// A later stretch of the same session added to what its record already says. A record keeps
// only the top counts, so a merged count can miss calls that fell outside them earlier.
export function mergeActivity(
  earlier: SessionActivity | undefined,
  later: SessionActivity | undefined,
): SessionActivity | undefined {
  if (!earlier) return later;
  if (!later) return earlier;
  const add = (a: Record<string, number>, b: Record<string, number>) => {
    const sum = { ...a };
    for (const [key, count] of Object.entries(b))
      sum[key] = (sum[key] ?? 0) + count;
    return sum;
  };
  const assistant =
    earlier.turnsAssistant === undefined && later.turnsAssistant === undefined
      ? undefined
      : (earlier.turnsAssistant ?? 0) + (later.turnsAssistant ?? 0);
  return {
    turnsUser: earlier.turnsUser + later.turnsUser,
    ...(assistant === undefined ? {} : { turnsAssistant: assistant }),
    tools: add(earlier.tools, later.tools),
    files: add(earlier.files, later.files),
    ...((later.model ?? earlier.model)
      ? { model: later.model ?? earlier.model }
      : {}),
    ...((later.branch ?? earlier.branch)
      ? { branch: later.branch ?? earlier.branch }
      : {}),
  };
}

const minutes = (started?: string, ended?: string) => {
  const span = Date.parse(ended ?? "") - Date.parse(started ?? "");
  return Number.isFinite(span) ? Math.max(0, Math.round(span / 60_000)) : null;
};

// The block's frontmatter lines, in a fixed order. A key with nothing derived is left out.
export function metadataLines(meta: SessionMetadata): string[] {
  const quote = (value: string) => JSON.stringify(value);
  const activity = meta.activity;
  const branch = meta.branch ?? activity?.branch;
  const duration = minutes(meta.started, meta.ended);
  const tools = activity ? topCounts(activity.tools, MAX_TOOLS) : [];
  const files = activity ? topCounts(activity.files, MAX_FILES) : [];
  return [
    `project_how: ${quote(meta.projectHow)}`,
    `project_confidence: ${quote(meta.projectConfidence)}`,
    ...(branch ? [`branch: ${quote(clip(branch, TEXT_CHARS))}`] : []),
    ...(meta.started ? [`started: ${quote(meta.started)}`] : []),
    ...(meta.ended ? [`ended: ${quote(meta.ended)}`] : []),
    ...(duration === null ? [] : [`duration_min: ${duration}`]),
    ...(activity ? [`turns_user: ${activity.turnsUser}`] : []),
    ...(activity?.turnsAssistant === undefined
      ? []
      : [`turns_assistant: ${activity.turnsAssistant}`]),
    ...(tools.length
      ? [
          `tools: ${JSON.stringify(Object.fromEntries(tools.map(([name, count]) => [clip(name, NAME_CHARS), count])))}`,
        ]
      : []),
    ...(files.length
      ? [
          `files: ${JSON.stringify(files.map(([file]) => clip(file, PATH_CHARS)))}`,
        ]
      : []),
    ...(activity?.model ? [`model: ${quote(activity.model)}`] : []),
    ...(meta.extraction
      ? [
          `extraction: ${JSON.stringify({
            model: clip(meta.extraction.model, TEXT_CHARS),
            input_chars: Math.max(0, Math.round(meta.extraction.inputChars)),
            ms: Math.max(0, Math.round(meta.extraction.ms)),
          })}`,
        ]
      : []),
  ];
}

const json = (value: string | undefined): unknown => {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const count = (value: string | undefined) => {
  const number = Number(value);
  return value !== undefined && value !== "" && Number.isInteger(number)
    ? number
    : undefined;
};

const isCounts = (value: unknown): value is Record<string, number> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((each) => Number.isFinite(each));

export type RecordMetadata = {
  projectHow?: string;
  projectConfidence?: string;
  task?: string;
  branch?: string;
  started?: string;
  ended?: string;
  durationMin?: number;
  activity?: SessionActivity;
  extraction?: ExtractionCost;
};

// The block back from a record's flat frontmatter fields (parseFrontmatter's output): what the
// start brief, the weekly patterns and brain_search read instead of the record's body. A record
// written before T-334 has none of it.
export function readMetadata(fields: Record<string, string>): RecordMetadata {
  const tools = json(fields.tools);
  const files = json(fields.files);
  const extraction = json(fields.extraction) as
    | { model?: unknown; input_chars?: unknown; ms?: unknown }
    | undefined;
  const turnsUser = count(fields.turns_user);
  const turnsAssistant = count(fields.turns_assistant);
  const hasActivity =
    turnsUser !== undefined || isCounts(tools) || Array.isArray(files);
  const text = (key: string) => fields[key] || undefined;
  return {
    ...(text("project_how") ? { projectHow: text("project_how") } : {}),
    ...(text("project_confidence")
      ? { projectConfidence: text("project_confidence") }
      : {}),
    ...(text("task") ? { task: text("task") } : {}),
    ...(text("branch") ? { branch: text("branch") } : {}),
    ...(text("started") ? { started: text("started") } : {}),
    ...(text("ended") ? { ended: text("ended") } : {}),
    ...(count(fields.duration_min) === undefined
      ? {}
      : { durationMin: count(fields.duration_min) }),
    ...(hasActivity
      ? {
          activity: {
            turnsUser: turnsUser ?? 0,
            ...(turnsAssistant === undefined ? {} : { turnsAssistant }),
            tools: isCounts(tools) ? tools : {},
            // Order is rank: the first path was touched most.
            files: Array.isArray(files)
              ? Object.fromEntries(
                  files
                    .filter((file): file is string => typeof file === "string")
                    .map((file, index) => [file, files.length - index]),
                )
              : {},
            ...(text("model") ? { model: text("model") } : {}),
            ...(text("branch") ? { branch: text("branch") } : {}),
          },
        }
      : {}),
    ...(extraction &&
    typeof extraction.model === "string" &&
    typeof extraction.input_chars === "number" &&
    typeof extraction.ms === "number"
      ? {
          extraction: {
            model: extraction.model,
            inputChars: extraction.input_chars,
            ms: extraction.ms,
          },
        }
      : {}),
  };
}
