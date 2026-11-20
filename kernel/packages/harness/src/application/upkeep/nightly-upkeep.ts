import { spawn } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, withFileLock } from "@ocean/core/shared/fs-utils.js";
import {
  KNOWLEDGE_DIR,
  oceanPath,
  SYSTEM_DIR,
} from "@ocean/core/shared/paths.js";
import { listTaskLoops } from "@ocean/loop/loops/task-loop.js";
import { hygieneFile } from "@ocean/services/hygiene/hygiene.js";
import {
  scorecardFile,
  searchEvalFile,
} from "@ocean/services/scorecard/scorecard.js";
import {
  type JobResult,
  type JobRun,
  type ModelBudget,
  previousScorecard,
  renderDigest,
  runUpkeepJobs,
  scorecardMoves,
  type UpkeepJob,
  writeDigest,
} from "@ocean/services/upkeep/upkeep.js";
import { listSchedules } from "../scheduler/local-scheduler.js";

// Nightly upkeep (T-322): each job is a child `ocean` process with a timeout; the results become
// the morning digest in 01-daily/digest/. Once a day through `ocean rhythm` (ifDue), and the
// monthly memory hygiene joins the first run of a month that has no report yet.

const MINUTE = 60_000;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const stampFile = () => oceanPath(SYSTEM_DIR, "state", "upkeep.json");
const evalSet = () => oceanPath(KNOWLEDGE_DIR, "evals", "search.jsonl");

const json = (stdout: string) => {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
};

function nightlyJobs(): UpkeepJob[] {
  return [
    {
      id: "doctor",
      args: ["doctor", "--json"],
      timeoutMs: 5 * MINUTE,
      model: null,
      summarize: (stdout) => {
        const findings: { severity: string }[] = json(stdout)?.findings ?? [];
        const count = (severity: string) =>
          findings.filter((finding) => finding.severity === severity).length;
        return {
          note: `${count("OK")} ok, ${count("WARN")} warn, ${count("ERROR")} error`,
          ok: count("ERROR") === 0,
        };
      },
    },
    {
      id: "telemetry",
      args: ["telemetry", "--yes"],
      timeoutMs: 5 * MINUTE,
      model: null,
      summarize: (stdout) => {
        const findings = json(stdout)?.findings;
        return {
          note: Array.isArray(findings)
            ? `${findings.length} recurring findings`
            : "ok",
        };
      },
    },
    {
      id: "reindex",
      args: ["memory", "reindex"],
      timeoutMs: 20 * MINUTE,
      model: null,
    },
    {
      id: "search-eval",
      args: ["memory", "eval", evalSet(), "--min", "0"],
      timeoutMs: 10 * MINUTE,
      model: null,
      summarize: (stdout) => {
        const result = json(stdout);
        if (typeof result?.recall !== "number")
          return { note: "no eval result", ok: false };
        return {
          note: `hit@${result.k} ${(result.recall * 100).toFixed(0)}%, hit@1 ${(result.hitAt1 * 100).toFixed(0)}%, MRR ${result.mrr.toFixed(2)} over ${result.total} (${result.settings?.mode ?? "?"})`,
        };
      },
    },
    {
      id: "drift",
      args: ["memory", "drift", "--yes"],
      timeoutMs: 5 * MINUTE,
      model: null,
      summarize: (stdout) => {
        const result = json(stdout);
        if (!result) return { note: "no result", ok: false };
        return {
          note: result.since
            ? `${result.unrecorded.length} of ${result.records} records changed with no recorded write`
            : `first snapshot of ${result.records} records`,
        };
      },
    },
    {
      id: "curator",
      args: ["curator", "--yes"],
      timeoutMs: 5 * MINUTE,
      model: null,
      summarize: (stdout) => {
        const actions: { key: string; action: string }[] =
          json(stdout)?.actions ?? [];
        return {
          note: actions.length
            ? actions.map((item) => `${item.action} ${item.key}`).join(", ")
            : "no changes",
        };
      },
    },
    {
      id: "scorecard",
      args: ["scorecard", "--write"],
      timeoutMs: 5 * MINUTE,
      model: null,
      summarize: () => ({ note: "saved" }),
    },
  ];
}

function runChild(job: UpkeepJob): Promise<JobRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [process.argv[1], ...job.args], {
      cwd: oceanPath(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OCEAN_NO_PULL_ON_START: "1" },
    });
    let stdout = "";
    let stderr = "";
    const take = (current: string, chunk: Buffer) =>
      current.length < OUTPUT_LIMIT
        ? current + chunk.toString("utf8")
        : current;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = take(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = take(stderr, chunk);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, job.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    });
  });
}

const hygieneJob: UpkeepJob = {
  id: "memory-hygiene",
  args: ["memory", "hygiene", "--yes"],
  timeoutMs: 20 * MINUTE,
  model: null,
  summarize: (stdout) => {
    const counts = json(stdout)?.counts;
    return counts
      ? {
          note: `${counts.verified} verified, ${counts.drifted} drifted, ${counts.unverifiable} unverifiable of ${counts.records}`,
        }
      : { note: "no result", ok: false };
  },
};

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

// Tonight's jobs: the nightly set, plus hygiene when this month has no report yet. Scorecard
// stays last so it reads what the others wrote.
export async function upkeepJobs(today: string): Promise<UpkeepJob[]> {
  const jobs = nightlyJobs();
  if (await exists(hygieneFile(today.slice(0, 7)))) return jobs;
  return [...jobs.slice(0, -1), hygieneJob, ...jobs.slice(-1)];
}

// Every guarded schedule and loop with its token budget, for the digest's model-calls section.
async function modelBudgets(): Promise<ModelBudget[]> {
  const budgets: ModelBudget[] = [];
  for (const schedule of await listSchedules())
    if (schedule.guard)
      budgets.push({
        id: schedule.id,
        kind: "schedule",
        active: schedule.enabled,
        used: schedule.usage?.tokens ?? 0,
        budget: schedule.guard.budgetTokens,
        stopped: schedule.stoppedReason,
      });
  for (const loop of await listTaskLoops())
    if (loop.guard && loop.status === "active")
      budgets.push({
        id: loop.id,
        kind: "loop",
        active: true,
        used: loop.usage?.tokens ?? 0,
        budget: loop.guard.budgetTokens,
      });
  return budgets;
}

type Stamp = { day?: string };
const readStamp = async (): Promise<Stamp> =>
  JSON.parse(await readFile(stampFile(), "utf8").catch(() => "{}"));

export async function upkeepDoneToday(today: string): Promise<boolean> {
  return (await readStamp()).day === today;
}

// Runs tonight's jobs and writes the digest; null when ifDue and another run already did today.
export async function runNightlyUpkeep(options: {
  today: string;
  ifDue: boolean;
}): Promise<{ digest: string; results: JobResult[] } | null> {
  const { today } = options;
  await mkdir(path.dirname(stampFile()), { recursive: true });
  return withFileLock(stampFile(), async () => {
    // A second caller waited for the lock while the first ran today's upkeep.
    if (options.ifDue && (await upkeepDoneToday(today))) return null;
    const results = await runUpkeepJobs(
      await upkeepJobs(today),
      async (job) => {
        const outcome = await runChild(job);
        if (job.id === "search-eval" && outcome.exitCode === 0) {
          const result = json(outcome.stdout);
          if (typeof result?.recall === "number")
            await atomicWrite(
              searchEvalFile(),
              `${JSON.stringify({ hitAt5: result.recall, k: result.k, at: new Date().toISOString(), settings: result.settings }, null, 2)}\n`,
            );
        }
        return outcome;
      },
    );
    const before = await previousScorecard(today);
    const after = await readFile(scorecardFile(today), "utf8").catch(
      () => null,
    );
    const digest = await writeDigest(
      today,
      renderDigest({
        date: today,
        results,
        moves: scorecardMoves(before, after),
        hasPrevious: before !== null,
        budgets: await modelBudgets().catch(() => []),
      }),
    );
    await atomicWrite(
      stampFile(),
      `${JSON.stringify({ day: today } satisfies Stamp, null, 2)}\n`,
    );
    return { digest, results };
  });
}
