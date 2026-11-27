import { readFile } from "node:fs/promises";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";

// `ocean profiles doctor` (T-338 P5): what bridge/state/profiles/selections.jsonl says about
// routing. Sessions (`hook`, `context`) and tasks (`ocean run`, `profiles suggest`) share the
// log; the report counts them and turns repeated patterns into findings, and each finding into
// a suggestion the owner may apply. It never edits a profile or a project itself.

export type SelectionLine = {
  ts?: string;
  source?: string;
  project?: string;
  profile?: string;
  secondary?: string[];
  confidence?: string;
  task?: string;
  override?: boolean;
  suggested?: { profile?: string };
};

export type ProfileFinding = {
  kind:
    | "unknown-profile"
    | "unrouted-project"
    | "recurring-secondary"
    | "task-override";
  count: number;
  detail: string;
  // What would fix it, for the owner to approve; never applied by the doctor.
  suggestion: string;
};

export type ProfileDoctorReport = {
  log: string;
  days: number;
  lines: number;
  sessions: number;
  tasks: number;
  unreadable: number;
  byProfile: Record<string, number>;
  byConfidence: Record<string, number>;
  findings: ProfileFinding[];
};

// A pattern has to repeat before it is a finding: one odd session is noise.
const REPEAT = 3;

const bump = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

export function selectionsLog(): string {
  return oceanPath(SYSTEM_DIR, "state", "profiles", "selections.jsonl");
}

export function profileDoctor(
  text: string,
  known: string[],
  options: { days?: number; now?: Date; log?: string } = {},
): ProfileDoctorReport {
  const days = options.days ?? 30;
  const since = (options.now ?? new Date()).getTime() - days * 86_400_000;
  const names = new Set(known);
  const report: ProfileDoctorReport = {
    log: options.log ?? "bridge/state/profiles/selections.jsonl",
    days,
    lines: 0,
    sessions: 0,
    tasks: 0,
    unreadable: 0,
    byProfile: {},
    byConfidence: {},
    findings: [],
  };
  const unknown: Record<string, number> = {};
  // Per bound project: sessions, those that matched nothing, and secondaries added by prompts.
  const projects = new Map<
    string,
    { sessions: number; unmatched: number; secondary: Record<string, number> }
  >();
  const overrides: Record<string, string[]> = {};
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let line: SelectionLine;
    try {
      line = JSON.parse(raw);
    } catch {
      report.unreadable += 1;
      continue;
    }
    const at = line.ts ? Date.parse(line.ts) : Number.NaN;
    if (Number.isNaN(at) || at < since) continue;
    report.lines += 1;
    const profile = line.profile ?? "?";
    bump(report.byProfile, profile);
    if (names.size && !names.has(profile)) bump(unknown, profile);
    if (line.task) {
      report.tasks += 1;
      const suggested = line.suggested?.profile;
      if (line.override && suggested && suggested !== profile) {
        const pair = `${suggested} → ${profile}`;
        overrides[pair] = [...(overrides[pair] ?? []), line.task];
      }
      continue;
    }
    report.sessions += 1;
    bump(report.byConfidence, line.confidence ?? "?");
    const project = line.project;
    if (!project || project === "unbound") continue;
    const entry = projects.get(project) ?? {
      sessions: 0,
      unmatched: 0,
      secondary: {},
    };
    entry.sessions += 1;
    if (line.confidence === "none") entry.unmatched += 1;
    for (const name of line.secondary ?? []) bump(entry.secondary, name);
    projects.set(project, entry);
  }
  for (const [profile, count] of Object.entries(unknown))
    report.findings.push({
      kind: "unknown-profile",
      count,
      detail: `${count} selections name ${profile}, which no installed profile is called`,
      suggestion:
        "older lines from before a rename are harmless; if new ones keep coming, run `ocean profiles validate`",
    });
  for (const [project, entry] of projects) {
    if (entry.unmatched >= REPEAT && entry.unmatched === entry.sessions)
      report.findings.push({
        kind: "unrouted-project",
        count: entry.unmatched,
        detail: `every session in ${project} (${entry.sessions}) matched nothing and fell back to base`,
        suggestion: `bind it to a profile: \`ocean project register\` fills project.json profiles from its signals, or set profiles in ${project}'s project.json`,
      });
    for (const [secondary, count] of Object.entries(entry.secondary))
      if (count >= REPEAT)
        report.findings.push({
          kind: "recurring-secondary",
          count,
          detail: `prompts in ${project} added ${secondary} as a secondary profile ${count} times`,
          suggestion: `add ${secondary} to ${project}'s project.json profiles so its tools are there from the start`,
        });
  }
  for (const [pair, tasks] of Object.entries(overrides))
    if (tasks.length >= 2)
      report.findings.push({
        kind: "task-override",
        count: tasks.length,
        detail: `tasks were moved ${pair} by hand ${tasks.length} times (${tasks.slice(-3).join(", ")})`,
        suggestion: `add a trigger from those tasks' titles to ${pair.split(" → ")[1]}'s triggers`,
      });
  report.findings.sort((a, b) => b.count - a.count);
  return report;
}

export async function readSelections(log = selectionsLog()): Promise<string> {
  try {
    return await readFile(log, "utf8");
  } catch {
    return "";
  }
}
