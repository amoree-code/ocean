import {
  recordDesktopRun,
  runDesktopFacts,
} from "@ocean/loop/hooks/desktop-facts.js";
import {
  ClaudeExportError,
  readExportChats,
} from "../../infrastructure/desktop/claude-export.js";
import {
  DesktopChatUnreadable,
  readDesktopChats,
} from "../../infrastructure/desktop/desktop-chat.js";
import { sessionFactsCompleter } from "../../infrastructure/providers/session-facts-completer.js";

export const desktopUsage =
  "ocean desktop capture [--dry-run] [--export <folder>] [--since <date>] [--quiet <minutes>] [--latest] [--wait <seconds>] [--json]";

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

type Source = typeof readDesktopChats;

async function dryRun(source: Source, json: boolean): Promise<void> {
  const read = await source();
  if (read.status === "absent") {
    if (json) console.log(JSON.stringify({ status: "absent" }));
    else console.log("Claude Desktop's local chat store was not found.");
    return;
  }
  const rows = read.conversations.map((conversation) => ({
    uuid: conversation.uuid,
    updatedAt: conversation.updatedAt,
    messages: conversation.messageCount,
    human: conversation.messages.filter((m) => m.sender === "human").length,
  }));
  if (json) {
    console.log(
      JSON.stringify(
        { status: "ok", conversations: rows, skipped: read.skipped },
        null,
        2,
      ),
    );
    return;
  }
  console.log(
    `${rows.length} conversation(s) readable${read.skipped ? `, ${read.skipped} record(s) skipped` : ""}:`,
  );
  for (const row of rows)
    console.log(
      `  ${row.uuid}  ${row.updatedAt}  ${row.messages} messages (${row.human} yours)`,
    );
}

// `ocean desktop capture` (T-315): Claude Desktop chat has no hooks, so this is what the
// watcher runs. `--dry-run` lists the conversations Ocean can read, with message counts; the
// real run sends the new turns of each closed conversation to fact capture (T-329: quiet two
// hours, or ten minutes once a newer one has started); `--latest` reads the newest one now,
// after `--wait` seconds (`ocean_session_save`). Neither prints
// message text; the run's outcome is kept for `ocean doctor`. `--export <folder>` reads an
// unpacked claude.ai data export's conversations.json instead (every device's conversations),
// with the same cursor, so a conversation already read from the app is not read again; an
// export is static, so it has no quiet window, and its run is not the watcher's last run.
export async function runDesktopCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  const since = flagValue(rest, "--since");
  const quiet = flagValue(rest, "--quiet");
  const sinceDate = since ? new Date(since) : undefined;
  const quietMinutes = quiet === undefined ? undefined : Number(quiet);
  if (
    action !== "capture" ||
    (sinceDate && Number.isNaN(sinceDate.getTime())) ||
    (quietMinutes !== undefined &&
      !(Number.isFinite(quietMinutes) && quietMinutes >= 0))
  ) {
    console.error(`Usage: ${desktopUsage}`);
    process.exitCode = 1;
    return;
  }
  const json = rest.includes("--json");
  const wait = Number(flagValue(rest, "--wait") ?? 0);
  if (Number.isFinite(wait) && wait > 0)
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(wait, 300) * 1000),
    );
  const exportDir = flagValue(rest, "--export");
  if (rest.includes("--export") && (!exportDir || exportDir.startsWith("--"))) {
    console.error(`Usage: ${desktopUsage}`);
    process.exitCode = 1;
    return;
  }
  const read: Source = exportDir
    ? () => readExportChats(exportDir)
    : () => readDesktopChats();
  try {
    if (rest.includes("--dry-run")) {
      await dryRun(read, json);
      return;
    }
    const run = await runDesktopFacts({
      read,
      complete: sessionFactsCompleter("claude"),
      since: sinceDate,
      latest: rest.includes("--latest"),
      quietMs:
        quietMinutes !== undefined
          ? quietMinutes * 60_000
          : exportDir
            ? 0
            : undefined,
    });
    if (exportDir) {
      console.log(JSON.stringify(run, null, 2));
      return;
    }
    const count = (key: "candidates" | "filed") =>
      run.status === "done"
        ? run.runs.reduce((sum, each) => sum + (each[key]?.length ?? 0), 0)
        : 0;
    await recordDesktopRun({
      at: new Date().toISOString(),
      status: run.status,
      ...(run.status === "done"
        ? {
            conversations: run.conversations,
            captured: run.runs.length,
            candidates: count("candidates"),
            filed: count("filed"),
          }
        : {}),
    });
    console.log(JSON.stringify(run, null, 2));
  } catch (error) {
    if (error instanceof ClaudeExportError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    if (!(error instanceof DesktopChatUnreadable)) throw error;
    await recordDesktopRun({
      at: new Date().toISOString(),
      status: "unreadable",
      code: error.code,
      reason: error.message,
    });
    if (json)
      console.log(
        JSON.stringify({
          status: "unreadable",
          code: error.code,
          reason: error.message,
        }),
      );
    else console.error(`${error.code}: ${error.message}`);
    process.exitCode = 1;
  }
}
