import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "@ocean/core/shared/fs-utils.js";
import { DAILY_DIR, oceanPath } from "@ocean/core/shared/paths.js";
import { scorecardFile } from "../scorecard/scorecard.js";

// Nightly upkeep (T-322): the deterministic jobs `ocean rhythm` runs once a day, and the morning
// digest that says what ran, what failed and which scorecard rows moved. A job that would call a
// model must declare a token cap; the runner refuses one without it, and the digest lists every cap.

export type UpkeepJob = {
  id: string;
  // CLI arguments after `ocean`.
  args: string[];
  timeoutMs: number;
  // null = no model is called. A model job without a positive cap is refused, never run.
  model: { maxTokens: number } | null;
  // One line from the job's stdout for the digest; ok=false marks a soft failure.
  summarize?: (stdout: string) => { note: string; ok?: boolean };
};

export type JobRun = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type JobResult = {
  id: string;
  ok: boolean;
  ms: number;
  note: string;
  model: UpkeepJob["model"];
};

export type ScorecardMove = { label: string; from: string; to: string };

// A recurring agent run (scheduled job or task loop) and its guard's token budget (T-322, C2).
export type ModelBudget = {
  id: string;
  kind: "schedule" | "loop";
  active: boolean;
  used: number;
  budget: number;
  stopped?: string;
};

const tokens = (n: number) => n.toLocaleString("en-US");

const lastLine = (text: string) =>
  text.trim().split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 200) ?? "";

export async function runUpkeepJobs(
  jobs: UpkeepJob[],
  run: (job: UpkeepJob) => Promise<JobRun>,
  clock: () => number = Date.now,
): Promise<JobResult[]> {
  const results: JobResult[] = [];
  for (const job of jobs) {
    const started = clock();
    if (job.model && !(job.model.maxTokens > 0)) {
      results.push({
        id: job.id,
        ok: false,
        ms: 0,
        note: "refused: a model job needs a positive token cap",
        model: job.model,
      });
      continue;
    }
    let result: JobResult;
    try {
      const outcome = await run(job);
      const failed = outcome.timedOut || outcome.exitCode !== 0;
      const summary = job.summarize?.(outcome.stdout);
      result = {
        id: job.id,
        ok: !failed && summary?.ok !== false,
        ms: clock() - started,
        note: outcome.timedOut
          ? `timed out after ${Math.round(job.timeoutMs / 1000)} s`
          : (summary?.note ??
            (failed
              ? `exit ${outcome.exitCode}: ${lastLine(outcome.stderr) || lastLine(outcome.stdout)}`
              : "ok")),
        model: job.model,
      };
    } catch (error) {
      result = {
        id: job.id,
        ok: false,
        ms: clock() - started,
        note: error instanceof Error ? error.message : String(error),
        model: job.model,
      };
    }
    results.push(result);
  }
  return results;
}

// The scorecard as label → value, read back from its markdown table.
export function parseScorecard(markdown: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith("| ") || line.startsWith("| Measure")) continue;
    const cells = line
      .slice(2, -2)
      .split(/(?<!\\) \| /)
      .map((cell) => cell.replace(/\\\|/g, "|"));
    if (cells.length >= 2) rows.set(cells[0], cells[1]);
  }
  return rows;
}

export function scorecardMoves(
  before: string | null,
  after: string | null,
): ScorecardMove[] {
  if (!before || !after) return [];
  const old = parseScorecard(before);
  const moves: ScorecardMove[] = [];
  for (const [label, to] of parseScorecard(after)) {
    const from = old.get(label);
    if (from !== undefined && from !== to) moves.push({ label, from, to });
  }
  return moves;
}

// The newest scorecard dated before `date`, for the digest's "moved" section.
export async function previousScorecard(date: string): Promise<string | null> {
  const dir = path.dirname(scorecardFile(date));
  const earlier = (await readdir(dir).catch(() => [] as string[]))
    .filter(
      (name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name) && name < `${date}.md`,
    )
    .sort()
    .at(-1);
  return earlier ? readFile(path.join(dir, earlier), "utf8") : null;
}

export const digestFile = (date: string) =>
  oceanPath(DAILY_DIR, "digest", `${date}.md`);

export function renderDigest(input: {
  date: string;
  results: JobResult[];
  moves: ScorecardMove[];
  hasPrevious: boolean;
  budgets?: ModelBudget[];
  extra?: string[];
}): string {
  const failed = input.results.filter((result) => !result.ok);
  const cell = (text: string) => text.replace(/\|/g, "\\|");
  const capped = input.results.filter((result) => result.model);
  return [
    "---",
    "type: digest",
    `date: ${input.date}`,
    `jobs: ${input.results.length}`,
    `failed: ${failed.length}`,
    "---",
    "",
    `# Ocean morning digest — ${input.date}`,
    "",
    failed.length
      ? `**${failed.length} of ${input.results.length} jobs failed:** ${failed.map((result) => result.id).join(", ")}.`
      : `All ${input.results.length} jobs ran.`,
    "",
    "## What ran",
    "",
    "| Job | Result | Time | Note |",
    "|---|---|---|---|",
    ...input.results.map(
      (result) =>
        `| ${result.id} | ${result.ok ? "ok" : "**failed**"} | ${(result.ms / 1000).toFixed(1)} s | ${cell(result.note)} |`,
    ),
    "",
    "## Model calls",
    "",
    capped.length
      ? capped
          .map(
            (result) =>
              `- ${result.id}: capped at ${tokens(result.model?.maxTokens ?? 0)} tokens`,
          )
          .join("\n")
      : "None in tonight's jobs — every one is deterministic.",
    "",
    "Recurring agent runs:",
    "",
    input.budgets?.length
      ? input.budgets
          .map(
            (item) =>
              `- ${item.kind} ${item.id}: ${tokens(item.used)} of ${tokens(item.budget)} tokens${item.active ? "" : item.stopped ? ` — stopped: ${item.stopped}` : " — not active"}`,
          )
          .join("\n")
      : "None.",
    "",
    "## Scorecard rows that moved",
    "",
    !input.hasPrevious
      ? "No earlier scorecard to compare with."
      : input.moves.length
        ? input.moves
            .map((move) => `- **${move.label}:** ${move.from} → ${move.to}`)
            .join("\n")
        : "None.",
    "",
    ...(input.extra?.length ? [...input.extra, ""] : []),
  ].join("\n");
}

export async function writeDigest(date: string, text: string): Promise<string> {
  const file = digestFile(date);
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, text);
  return file;
}
