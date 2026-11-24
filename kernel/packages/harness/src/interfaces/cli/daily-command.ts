import { createInterface } from "node:readline/promises";
import { listLessons, setLessonStatus } from "@ocean/brain/memory/lessons.js";
import { localDate } from "@ocean/core/shared/local-date.js";
import { prepareDay } from "@ocean/services/day/day.js";
import { readCallLedger } from "@ocean/services/infrastructure/mcp/call-ledger.js";

/**
 * Interactive human-in-the-loop gate for candidate lessons (see lessons.ts). Only runs on a
 * real TTY, so headless and scheduled invocations of `ocean daily start` never block on input.
 */
const lessonGateLimit = 5;

async function runLessonGate(): Promise<void> {
  if (!(process.stdin.isTTY && process.stdout.isTTY)) return;
  const allPending = await listLessons({ status: "candidate" });
  if (!allPending.length) return;
  const pending = allPending.slice(-lessonGateLimit);
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    console.log(
      allPending.length > pending.length
        ? `\n🤖 Ocean: ${pending.length} most recent of ${allPending.length} candidate lesson(s) awaiting review.`
        : `\n🤖 Ocean: ${pending.length} candidate lesson(s) awaiting review.`,
    );
    for (const lesson of pending) {
      console.log(`\n[${lesson.hits} verified hit(s)] ${lesson.title}`);
      const answer = (
        await prompt.question(
          "Activate this lesson? (y = activate, n = retire, Enter = later): ",
        )
      )
        .trim()
        .toLowerCase();
      // Only an explicit answer changes anything: Enter or EOF leaves it a candidate.
      if (answer !== "y" && answer !== "n") {
        console.log("→ left as candidate");
        continue;
      }
      await setLessonStatus(lesson.id, answer === "y" ? "active" : "retired");
      console.log(answer === "y" ? "→ active" : "→ retired");
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
  await runLessonGate();
  const apply = args.includes("--apply");
  const newsIndex = args.indexOf("--news");
  const news =
    newsIndex >= 0
      ? args
          .slice(newsIndex + 1)
          .join(" ")
          .slice(0, 4_000)
      : "";
  // The morning half of the daily note (T-314): focus, coming up, open loops, hours, what
  // waits on you, and the brief — between markers, so a rerun replaces only that block.
  const plan = await prepareDay({
    date: localDate(),
    apply,
    news,
    calls: readCallLedger,
  });
  console.log(JSON.stringify({ apply, ...plan }, null, 2));
  if (!apply) console.error("Dry run: pass --apply to write it.");
}
