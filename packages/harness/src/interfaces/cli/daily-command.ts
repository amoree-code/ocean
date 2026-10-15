import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { Session } from "@ocean/core/domain/sessions/session.js";
import {
  listObservations,
  reviewObservation,
} from "../../application/skills/task-observer.js";
import { withFileLock } from "../../fs-utils.js";
import { openSessionStore } from "../../infrastructure/persistence/session-store.js";
import { DAILY_DIR, oceanPath } from "../../paths.js";
import { listTasks } from "./tasks-command.js";

/**
 * Interactive human-in-the-loop gate for observations sitting in "observed"
 * status (see task-observer.ts). Only runs on a real TTY, so headless and
 * scheduled invocations of `ocean daily start` never block on input.
 */
const observationGateLimit = 5;

async function runObservationGate(): Promise<void> {
  if (!(process.stdin.isTTY && process.stdout.isTTY)) return;
  const allPending = (await listObservations()).filter(
    (observation) => observation.status === "observed",
  );
  if (!allPending.length) return;
  const pending = allPending.slice(-observationGateLimit);
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    console.log(
      allPending.length > pending.length
        ? `\n🤖 Ocean: ${pending.length} most recent of ${allPending.length} observation(s) awaiting review.`
        : `\n🤖 Ocean: ${pending.length} observation(s) awaiting review.`,
    );
    for (const observation of pending) {
      console.log(`\n[${observation.signalType}] ${observation.summary}`);
      const answer = await prompt.question(
        "Approve evolving this into a skill? (y/n): ",
      );
      const status =
        answer.trim().toLowerCase() === "y" ? "approved" : "rejected";
      const reviewed = await reviewObservation(
        observation.observationId,
        status,
      );
      console.log(
        reviewed.skillCandidateId
          ? `→ ${status} (skill candidate: ${reviewed.skillCandidateId})`
          : `→ ${status}`,
      );
    }
  } finally {
    prompt.close();
  }
}

export async function runDailyCommand(
  action: string,
  args: string[],
): Promise<void> {
  if (action !== "start") {
    console.error(
      "Usage: ocean daily start [--apply] [--news <bounded-news-summary>]",
    );
    process.exitCode = 1;
    return;
  }
  await runObservationGate();
  const apply = args.includes("--apply");
  const newsIndex = args.indexOf("--news");
  const news =
    newsIndex >= 0
      ? args
          .slice(newsIndex + 1)
          .join(" ")
          .slice(0, 4_000)
      : "";
  const tasks = await listTasks();
  const store = await openSessionStore();
  let sessions: Array<
    Pick<Session, "sessionId" | "title" | "provider" | "status" | "nextAction">
  >;
  try {
    sessions = store
      .list()
      .slice(0, 5)
      .map((session) => ({
        sessionId: session.sessionId,
        title: session.title,
        provider: session.provider,
        status: session.status,
        nextAction: session.nextAction,
      }));
  } finally {
    store.close();
  }
  const date = new Date().toISOString().slice(0, 10);
  const file = oceanPath(DAILY_DIR, `${date}.md`);
  const content = `${[
    `# Daily brief — ${date}`,
    "",
    "## Brief",
    "",
    tasks.length
      ? tasks
          .map((task) => `- ${task.id}: ${task.title} — ${task.goal}`)
          .join("\n")
      : "- No active tasks.",
    "",
    "## Check-in",
    "",
    sessions.length
      ? sessions
          .map(
            (session) =>
              `- ${session.sessionId}: ${session.title || session.provider} — ${session.status}${session.nextAction ? `; next: ${session.nextAction}` : ""}`,
          )
          .join("\n")
      : "- No recent sessions.",
    "",
    "## News",
    "",
    news ||
      "- No news supplied. The active AI client may research only the requested topics and pass a bounded summary with `--news`.",
  ]
    .join("\n")
    .slice(0, 12_000)}\n`;
  if (apply) {
    await mkdir(path.dirname(file), { recursive: true });
    // Same lock as the session-closeout writers: a closeout landing between the check and
    // the write would otherwise be overwritten (T-257).
    await withFileLock(file, async () => {
      const existing = await readFile(file, "utf8").catch(() => "");
      if (existing.trim())
        throw new Error(`Daily file already has content: ${file}`);
      await writeFile(file, content, "utf8");
    });
  }
  console.log(
    JSON.stringify(
      {
        apply,
        date,
        file,
        bytes: Buffer.byteLength(content),
        tasks: tasks.length,
        sessions: sessions.length,
        news: Boolean(news),
        content,
      },
      null,
      2,
    ),
  );
}
