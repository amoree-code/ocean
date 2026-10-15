import { randomUUID } from "node:crypto";
import { openSessionStore } from "../../infrastructure/persistence/session-store.js";

export async function runIdeaCommand(
  action: string,
  args: string[],
): Promise<void> {
  const store = await openSessionStore();
  try {
    if (action === "save") {
      const title = args[0];
      const sessionIndex = args.indexOf("--session");
      const content = args
        .slice(1, sessionIndex >= 0 ? sessionIndex : undefined)
        .join(" ")
        .trim();
      if (!title || !content)
        throw new Error(
          "Usage: ocean idea save <title> <content> [--session <session-id>]",
        );
      store.saveIdea({
        ideaId: `idea-${randomUUID()}`,
        title,
        content,
        sourceSessionId: sessionIndex >= 0 ? args[sessionIndex + 1] : null,
      });
      console.log(
        JSON.stringify({ saved: true, status: "raw", title }, null, 2),
      );
      return;
    }
    if (action === "list") {
      console.log(JSON.stringify(store.listIdeas(args[0]), null, 2));
      return;
    }
    if (action === "classify" || action === "discard") {
      const id = args[0];
      if (!id)
        throw new Error(`Usage: ocean idea ${action} <idea-id> [target]`);
      store.updateIdea(
        id,
        action === "discard" ? "discarded" : "classified",
        action === "classify" ? args[1] : undefined,
      );
      console.log(
        JSON.stringify(
          {
            ideaId: id,
            status: action === "discard" ? "discarded" : "classified",
            target: args[1] ?? null,
          },
          null,
          2,
        ),
      );
      return;
    }
    console.error(
      "Usage: ocean idea save <title> <content> [--session <id>]|list [status]|classify <id> <target>|discard <id>",
    );
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
