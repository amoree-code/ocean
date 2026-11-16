import {
  DesktopChatUnreadable,
  readDesktopChats,
} from "../../infrastructure/desktop/desktop-chat.js";

export const desktopUsage = "ocean desktop capture --dry-run [--json]";

// `ocean desktop capture --dry-run` (T-315): the Claude Desktop conversations Ocean can read,
// with message counts. Never prints message text.
export async function runDesktopCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action !== "capture" || !rest.includes("--dry-run")) {
    console.error(`Usage: ${desktopUsage}`);
    process.exitCode = 1;
    return;
  }
  const json = rest.includes("--json");
  try {
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
  } catch (error) {
    if (!(error instanceof DesktopChatUnreadable)) throw error;
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
