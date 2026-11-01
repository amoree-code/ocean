import { searchHistory } from "../../application/pull/history-index.js";
import { pull } from "../../application/pull/pull.js";

const usage =
  "Usage: ocean pull [--yes] [--daily] | search <words…> [--client <id>] [--limit N] [--json]";

// `ocean pull` (T-305): everything every AI client holds, into Ocean — memory and instruction
// files as review candidates, claude.ai exports from ~/Downloads, and a searchable index of every
// conversation. A dry run until --yes; `--daily` skips when the last pull is under a day old.
export async function runPullCommand(args: string[]): Promise<void> {
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  if (args[0] === "search") {
    const words = args
      .slice(1)
      .filter(
        (arg, index, all) =>
          !arg.startsWith("--") &&
          !["--client", "--limit"].includes(all[index - 1] ?? ""),
      );
    if (!words.length) throw new Error(usage);
    const limit = Number(value("--limit") ?? 20);
    const hits = await searchHistory(words.join(" "), {
      client: value("--client"),
      limit: Number.isFinite(limit) && limit > 0 ? limit : 20,
    });
    if (args.includes("--json")) {
      console.log(JSON.stringify(hits, null, 2));
      return;
    }
    for (const hit of hits)
      console.log(
        `${hit.updated.slice(0, 10)}  ${hit.client.padEnd(14)} ${hit.title || "(untitled)"}\n            ${hit.project ? `${hit.project}  ` : ""}${hit.file}`,
      );
    if (!hits.length) console.error("No conversation matches.");
    return;
  }
  if (args.some((arg) => !["--yes", "--daily"].includes(arg)))
    throw new Error(usage);
  const result = await pull({
    apply: args.includes("--yes"),
    daily: args.includes("--daily"),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.applied && !result.skipped)
    console.error(
      "Dry run: pass --yes to propose the new memory as candidates and write the history index; review with `ocean memory review`.",
    );
}
