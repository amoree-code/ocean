import {
  type CostRow,
  extractionLogFile,
  readExtractionLog,
  summarizeCost,
} from "@ocean/brain/memory/extraction-log.js";

const usage = "Usage: ocean sessions cost [--days N] [--weeks N] [--json]";

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
