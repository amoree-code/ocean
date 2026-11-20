import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionStoreFactory } from "@ocean/core/domain/ports/session-store-port.js";
import {
  type GuardUsage,
  guardStop,
  type LoopGuard,
} from "@ocean/core/domain/runs/loop-guard.js";
import { localDate } from "@ocean/core/shared/local-date.js";
import { INBOX_DIR, oceanPath } from "@ocean/core/shared/paths.js";
import { sessionTokens } from "../runs/session-tokens.js";

// Enforcing a LoopGuard after each run (T-322, C2), shared by scheduled jobs and task loops:
// count the run and its tokens, run the verifier, and — when a limit trips — say why and leave a
// note for the owner in 00-inbox/escalations/.

const VERIFY_TIMEOUT_MS = 5 * 60_000;

export function verifyPasses(command: string, cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "sh",
      ["-c", command],
      { cwd, timeout: VERIFY_TIMEOUT_MS },
      (error) => resolve(!error),
    );
  });
}

export async function tokensOfSession(
  sessionId: string,
  openStore: SessionStoreFactory,
): Promise<number> {
  try {
    const store = await openStore();
    try {
      return sessionTokens(store.listEvents(sessionId)) ?? 0;
    } finally {
      store.close();
    }
  } catch {
    return 0;
  }
}

export const emptyUsage = (): GuardUsage => ({
  runs: 0,
  tokens: 0,
  noProgress: 0,
});

// The usage after one more completed run, and the reason to stop (null: keep going).
export async function afterGuardedRun(
  guard: LoopGuard,
  usage: GuardUsage | undefined,
  sessionId: string,
  cwd: string,
  openStore: SessionStoreFactory,
): Promise<{ usage: GuardUsage; stop: string | null }> {
  const next = { ...(usage ?? emptyUsage()) };
  next.runs += 1;
  next.tokens += await tokensOfSession(sessionId, openStore);
  next.noProgress = (await verifyPasses(guard.verify, cwd))
    ? 0
    : next.noProgress + 1;
  return { usage: next, stop: guardStop(guard, next) };
}

export async function writeEscalation(input: {
  kind: "schedule" | "loop";
  id: string;
  reason: string;
  usage: GuardUsage;
  resume: string;
}): Promise<string> {
  const file = oceanPath(
    INBOX_DIR,
    "escalations",
    `${localDate()}-${input.kind}-${input.id}.md`,
  );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    [
      "---",
      "type: escalation",
      `${input.kind}: ${input.id}`,
      `date: ${localDate()}`,
      "---",
      "",
      `# ${input.kind === "schedule" ? "Schedule" : "Loop"} \`${input.id}\` stopped`,
      "",
      `Reason: ${input.reason}.`,
      "",
      `Usage: ${input.usage.runs} runs, ${input.usage.tokens} tokens, ${input.usage.noProgress} runs in a row without verified progress.`,
      "",
      `Look at it, then ${input.resume} to resume, or leave it stopped.`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return file;
}
