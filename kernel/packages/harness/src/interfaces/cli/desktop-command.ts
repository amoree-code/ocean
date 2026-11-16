import {
  DEFAULT_QUIET_MS,
  recordDesktopRun,
  runDesktopFacts,
} from "@ocean/loop/hooks/desktop-facts.js";
import {
  DesktopChatUnreadable,
  readDesktopChats,
} from "../../infrastructure/desktop/desktop-chat.js";
import { sessionFactsCompleter } from "../../infrastructure/providers/session-facts-completer.js";

export const desktopUsage =
  "ocean desktop capture [--dry-run] [--since <date>] [--quiet <minutes>] [--json]";

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function dryRun(json: boolean): Promise<void> {
  const read = await readDesktopChats();
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
    `${rows.length} Desktop conversation(s) readable${read.skipped ? `, ${read.skipped} record(s) skipped` : ""}:`,
  );
  for (const row of rows)
    console.log(
      `  ${row.uuid}  ${row.updatedAt}  ${row.messages} messages (${row.human} yours)`,
    );
}

// `ocean desktop capture` (T-315): Claude Desktop chat has no hooks, so this is what the
// watcher runs. `--dry-run` lists the conversations Ocean can read, with message counts; the
// real run sends the new turns of each quiet conversation to fact capture. Neither prints
// message text; the run's outcome is kept for `ocean doctor`.
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
  try {
    if (rest.includes("--dry-run")) {
      await dryRun(json);
      return;
    }
    const run = await runDesktopFacts({
      read: readDesktopChats,
      complete: sessionFactsCompleter("claude"),
      since: sinceDate,
      quietMs:
        quietMinutes === undefined ? DEFAULT_QUIET_MS : quietMinutes * 60_000,
    });
    const candidates =
      run.status === "done"
        ? run.runs.reduce(
            (sum, each) => sum + (each.candidates?.length ?? 0),
            0,
          )
        : 0;
    await recordDesktopRun({
      at: new Date().toISOString(),
      status: run.status,
      ...(run.status === "done"
        ? {
            conversations: run.conversations,
            captured: run.runs.length,
            candidates,
          }
        : {}),
    });
    console.log(JSON.stringify(run, null, 2));
  } catch (error) {
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
