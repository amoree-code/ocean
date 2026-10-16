import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateSessionEntryContract } from "@ocean/core/domain/sessions/entry-contract.js";
import {
  KNOWLEDGE_DIR,
  oceanPath,
  oceanRoot,
  PERSONAL_DIR,
  PROJECTS_DIR,
  WORKSPACE_PROJECT_ID,
} from "@ocean/core/shared/paths.js";
import { syncCaptureInbox } from "../../application/capture/inbox-sync.js";
import { syncMemoryIndexes } from "../../application/memory/index-sync.js";
import { sessionProjectId } from "../../application/sessions/session-projects.js";
import { redactRuntimeText } from "../../infrastructure/observability/runtime-logger.js";
import { openSessionStore } from "../../infrastructure/persistence/session-store.js";

export async function runCaptureCommand(
  action: string,
  args: string[],
): Promise<void> {
  const store = await openSessionStore();
  try {
    if (action === "add") {
      const content = redactRuntimeText(args.join(" ").trim());
      if (!content) throw new Error("Usage: ocean capture add <idea>");
      const sessionId = randomUUID();
      store.create({
        sessionId,
        provider: "manual",
        providerSessionId: null,
        parentSessionId: null,
        profile: "manual-capture",
        profileIdentity: "",
        workingDirectory: oceanRoot(),
        projectId: await sessionProjectId(oceanRoot()),
        resumeData: null,
      });
      store.appendEvent(
        sessionId,
        "session_entry_contract",
        JSON.stringify(
          validateSessionEntryContract({
            entryPoint: "ocean-run",
            controlLevel: "full-head",
            inputCapture: "semantic",
            contextTransport: "manual-capture",
            policyEnforcement: "explicit-capture-operation",
            promotion: "explicit-review",
            resume: "unsupported",
          }),
        ),
      );
      store.updateStatus(sessionId, "running");
      store.appendEvent(sessionId, "user_input", content);
      store.updateStatus(sessionId, "completed");
      store.scanCaptureItems(sessionId);
      await syncCaptureInbox(store);
      const [item] = store
        .listCaptureItems("new")
        .filter((candidate) => candidate.sessionId === sessionId);
      if (!item) throw new Error("Capture item was not created");
      console.log(
        JSON.stringify({ captureId: item.captureId, sessionId, status: "new" }),
      );
      return;
    }
    if (action === "scan") {
      const sessionId = args[0];
      const scanned = store.scanCaptureItems(sessionId);
      await syncCaptureInbox(store);
      console.log(JSON.stringify({ scanned }));
      return;
    }
    if (action === "list") {
      console.log(
        JSON.stringify(store.listCaptureItems(args[0] ?? "new"), null, 2),
      );
      return;
    }
    if (action === "promote" || action === "discard") {
      const captureId = Number(args[0]);
      if (!Number.isInteger(captureId))
        throw new Error(`Usage: ocean capture ${action} <capture-id> [target]`);
      if (action === "promote") {
        const item = store.getCaptureItem(captureId);
        if (!item) throw new Error(`Capture item not found: ${captureId}`);
        await promote(item, args[1]);
      }
      store.updateCaptureStatus(
        captureId,
        action === "promote" ? "promoted" : "discarded",
        args[1],
      );
      await syncCaptureInbox(store);
      console.log(
        JSON.stringify({
          captureId,
          status: action === "promote" ? "promoted" : "discarded",
          target: args[1] ?? null,
        }),
      );
      return;
    }
    console.error(
      "Usage: ocean capture add <idea>|scan [session-id]|list [status]|promote <id> <target>|discard <id>",
    );
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

async function promote(
  item: { captureId: number; content: string },
  target = "knowledge/results",
): Promise<void> {
  if (target.startsWith("memory/")) {
    const relative = target.slice("memory/".length);
    if (!relative.endsWith(".md") || relative.includes(".."))
      throw new Error("Memory target must be an existing canonical .md file.");
    const file = path.resolve(oceanPath(PERSONAL_DIR), relative);
    const memoryRoot = path.resolve(oceanPath(PERSONAL_DIR)) + path.sep;
    if (!file.startsWith(memoryRoot))
      throw new Error(`Memory target must stay inside ${PERSONAL_DIR}.`);
    const header = `\n\n## Captured note — ${new Date().toISOString().slice(0, 10)}\n\n${item.content.trim()}\n\n_Source: session-capture-${item.captureId}; review status: unverified._\n`;
    await appendFile(file, header);
    await syncMemoryIndexes(true);
    return;
  }
  if (target === "memory") {
    throw new Error(
      "Use an explicit canonical file, for example memory/goals.md.",
    );
  }
  if (target === "backlog") {
    await appendFile(
      oceanPath(PROJECTS_DIR, "backlog.md"),
      `\n- [TODO] (P2) ${WORKSPACE_PROJECT_ID} — ${item.content.replace(/\s+/g, " ").trim()}  {${new Date().toISOString().slice(0, 10)}}\n`,
    );
    return;
  }
  const match = target.match(
    /^knowledge\/(architecture|decisions|discoveries|failures|research|results|solutions|references)$/,
  );
  if (!match)
    throw new Error(
      "Target must be knowledge/<kind>, memory/<file>.md, or backlog.",
    );
  const safe = item.content
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  const slug = safe || `capture-${item.captureId}`;
  const file = path.join(
    oceanPath(KNOWLEDGE_DIR, match[1], `${slug}-${item.captureId}.md`),
  );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `---\nname: ${slug}-${item.captureId}\ndescription: Candidate promoted from a reviewed session input\nmetadata:\n  type: ${match[1] === "results" ? "task-result" : match[1].slice(0, -1)}\n  domain: ${match[1]}\n  status: current\n  verification: unverified\n  source: session-capture-${item.captureId}\n---\n\n${item.content.trim()}\n`,
  );
  await syncMemoryIndexes(true);
}
