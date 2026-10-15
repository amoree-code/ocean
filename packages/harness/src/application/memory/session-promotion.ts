import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionStoreFactory } from "@ocean/core/domain/ports/session-store-port.js";
import { redactRuntimeText } from "@ocean/core/domain/redaction/redaction.js";
import { KNOWLEDGE_DIR, oceanPath } from "../../paths.js";
import { syncMemoryIndexes } from "./index-sync.js";

const kinds = new Set([
  "architecture",
  "decisions",
  "discoveries",
  "failures",
  "research",
  "results",
  "solutions",
  "references",
]);

export async function promoteSessionToKnowledge(
  sessionId: string,
  openStore: SessionStoreFactory,
  target = "knowledge/results",
  approved = false,
): Promise<{ applied: boolean; sessionId: string; file?: string }> {
  if (!approved)
    throw new Error(
      "Session promotion requires explicit approval: use --approve or approved: true",
    );
  const match = /^knowledge\/(\w+)$/.exec(target);
  if (!match || !kinds.has(match[1]))
    throw new Error(
      "Target must be knowledge/<architecture|decisions|discoveries|failures|research|results|solutions|references>",
    );
  const store = await openStore();
  try {
    const session = store.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status !== "completed")
      throw new Error(
        `Only completed sessions can be promoted: ${session.status}`,
      );
    const events = store.listEvents(sessionId);
    const evidence = events
      .filter((event) => event.type === "evidence")
      .map((event) => event.data)
      .some((data) => /"result"\s*:\s*"proven"/.test(data));
    if (!evidence)
      throw new Error(
        "Session lacks independently recorded successful evidence",
      );
    const input =
      events.find((event) => event.type === "user_input")?.data ?? "";
    const outputs = events
      .filter(
        (event) =>
          event.type === "provider_output" ||
          event.type === "text" ||
          event.type === "json",
      )
      .map((event) => redactRuntimeText(event.data).trim())
      .filter(Boolean);
    if (!outputs.length)
      throw new Error("Session has no provider output to promote");
    const slug = `${session.provider}-${sessionId.slice(0, 8)}`.replace(
      /[^a-zA-Z0-9-]+/g,
      "-",
    );
    const file = path.join(oceanPath(KNOWLEDGE_DIR, match[1], `${slug}.md`));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `---\nname: ${slug}\ndescription: Human-approved result from an Ocean session\nmetadata:\n  type: session-result\n  domain: ${match[1]}\n  status: current\n  verification: human-approved\n  source-session: ${sessionId}\n  provider: ${session.provider}\n---\n\n# ${session.provider} review\n\n## Request\n\n${redactRuntimeText(input)}\n\n## Result\n\n${outputs.join("\n\n")}\n`,
    );
    store.appendEvent(
      sessionId,
      "knowledge_promoted",
      JSON.stringify({
        file: path.relative(oceanPath(KNOWLEDGE_DIR), file),
        target,
        approved: true,
      }),
    );
    await syncMemoryIndexes(true);
    return { applied: true, sessionId, file: path.relative(oceanPath(), file) };
  } finally {
    store.close();
  }
}
