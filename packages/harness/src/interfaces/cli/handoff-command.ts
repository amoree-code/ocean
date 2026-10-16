import {
  createHandoff,
  getHandoff,
  listHandoffs,
} from "@ocean/loop/handoff/handoff-service.js";
import { defaultSessionStoreFactory } from "../../composition/runtime.js";

export async function runHandoffCommand(
  action: string,
  args: string[],
): Promise<void> {
  if (action === "create") {
    const taskIndex = args.indexOf("--task");
    const sessionIndex = args.indexOf("--session");
    const nextIndex = args.indexOf("--next");
    const providerIndex = args.indexOf("--provider");
    const handoff = await createHandoff(
      {
        taskId: taskIndex >= 0 ? args[taskIndex + 1] : undefined,
        sessionId: sessionIndex >= 0 ? args[sessionIndex + 1] : undefined,
        nextAction:
          nextIndex >= 0 ? args.slice(nextIndex + 1).join(" ") : undefined,
        provider: providerIndex >= 0 ? args[providerIndex + 1] : undefined,
      },
      defaultSessionStoreFactory,
    );
    console.log(JSON.stringify(handoff, null, 2));
    return;
  }
  if (action === "show" || action === "context") {
    const id = args[0];
    if (!id) throw new Error(`Usage: ocean handoff ${action} <handoff-id>`);
    const handoff = await getHandoff(
      id,
      defaultSessionStoreFactory,
      action === "context" ? 8_000 : 16_000,
    );
    console.log(JSON.stringify(handoff, null, 2));
    return;
  }
  if (action === "list") {
    const taskIndex = args.indexOf("--task");
    const projectIndex = args.indexOf("--project");
    console.log(
      JSON.stringify(
        await listHandoffs(
          defaultSessionStoreFactory,
          taskIndex >= 0 ? args[taskIndex + 1] : undefined,
          projectIndex >= 0 ? args[projectIndex + 1] : undefined,
        ),
        null,
        2,
      ),
    );
    return;
  }
  console.error(
    "Usage: ocean handoff create [--task <id>] [--session <id>] [--next <action>]|show <id>|context <id>|list [--task <id>] [--project <id>]",
  );
  process.exitCode = 1;
}
