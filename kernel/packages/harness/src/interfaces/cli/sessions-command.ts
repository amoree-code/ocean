import {
  type CostRow,
  extractionLogFile,
  readExtractionLog,
  summarizeCost,
} from "@ocean/brain/memory/extraction-log.js";
import { openSessionStoreReadOnly } from "@ocean/loop/infrastructure/persistence/session-store.js";
import {
  applyRelink,
  planRelink,
  type RelinkPlan,
} from "@ocean/loop/sessions/session-relink.js";

const usage = [
  "Usage: ocean sessions cost [--days N] [--weeks N] [--json]",
  "       ocean sessions relink (--dry-run | --yes) [--json]",
].join("\n");

const count = (args: string[], flag: string, fallback: number): number => {
  const index = args.indexOf(flag);
  const value = index >= 0 ? Number(args[index + 1]) : fallback;
  return Number.isInteger(value) && value > 0 && value <= 366
    ? value
    : fallback;
};

const seconds = (ms: number) => {
  const total = Math.round(ms / 1000);
  return total >= 60
    ? `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`
    : `${total}s`;
};

function table(title: string, rows: CostRow[]): string[] {
  const header = [
    title,
    "calls",
    "failed",
    "repeats",
    "input chars",
    "~tokens",
    "time",
  ];
  const lines = rows.map((row) => [
    row.period,
    String(row.calls),
    String(row.failed),
    String(row.repeats),
    row.input_chars.toLocaleString("en-US"),
    row.est_tokens.toLocaleString("en-US"),
    seconds(row.ms),
  ]);
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...lines.map((line) => line[column].length)),
  );
  const render = (cells: string[]) =>
    cells
      .map((cell, column) =>
        column === 0
          ? cell.padEnd(widths[column])
          : cell.padStart(widths[column]),
      )
      .join("  ");
  return [render(header), ...lines.map(render)];
}

// `ocean sessions cost` (T-335): what session capture's model calls cost, per day and week, from
// the extraction log. Tokens are estimated from characters; the client does not report them.
export async function runSessionsCommand(args: string[]): Promise<void> {
  if (args[0] === "relink") return relink(args.slice(1));
  if (args[0] !== "cost") {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  const summary = summarizeCost(await readExtractionLog(), {
    days: count(args, "--days", 7),
    weeks: count(args, "--weeks", 4),
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(
    [
      `Extraction calls behind session capture (${extractionLogFile()})`,
      "",
      ...table("day", summary.days),
      "",
      ...table("week of", summary.weeks),
    ].join("\n"),
  );
}

const clip = (value: string) =>
  value.length > 60 ? `${value.slice(0, 57)}...` : value;

function describe(plan: RelinkPlan): string[] {
  const lines: string[] = [];
  for (const change of plan.changes) {
    lines.push(change.file);
    for (const field of change.changes)
      lines.push(
        `  ${field.key}: ${JSON.stringify(clip(field.from))} → ${JSON.stringify(clip(field.to))}`,
      );
  }
  return lines;
}

// `ocean sessions relink` (T-337): old session records and review candidates brought to what new
// sessions write. --dry-run prints every change and writes nothing; --yes backs up, then writes.
async function relink(args: string[]): Promise<void> {
  const write = args.includes("--yes");
  if (write === args.includes("--dry-run")) {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  const store = await openSessionStoreReadOnly();
  let plan: RelinkPlan;
  try {
    plan = await planRelink(store);
  } finally {
    store.close();
  }
  const result = write ? await applyRelink(plan) : null;
  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          scanned: plan.scanned,
          changes: plan.changes.map(({ file, kind, changes }) => ({
            file,
            kind,
            changes,
          })),
          ...(result ? { result } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }
  const records = plan.changes.filter((c) => c.kind === "record").length;
  const summary = `${plan.changes.length} file(s) to change of ${plan.scanned} scanned (${records} record(s), ${plan.changes.length - records} candidate(s))`;
  if (!result) {
    console.log(
      [
        ...describe(plan),
        "",
        summary,
        "Dry run: nothing written. Write with --yes.",
      ]
        .join("\n")
        .trim(),
    );
    return;
  }
  console.log(
    [
      ...describe(plan),
      "",
      summary,
      `Written: ${result.written.length}. Backup: ${result.backup}`,
      ...(result.stale.length
        ? [
            `Changed since planned, left alone: ${result.stale.length}`,
            ...result.stale.map((file) => `  ${file}`),
          ]
        : []),
    ].join("\n"),
  );
}
