// The guard every recurring agent run declares (T-322, COG C2 loop engineering): how a run is
// verified, a hard cap on runs, a token budget, when to stop for lack of progress, and who is
// told when it stops. A scheduled job or loop without a complete guard is refused at creation.

export type LoopGuard = {
  // Shell command run after each run, in the Ocean root; exit 0 = verified progress.
  verify: string;
  // Hard cap: the job stops after this many runs.
  maxRuns: number;
  // Total tokens the job may spend across its runs; it stops once they are used.
  budgetTokens: number;
  // Consecutive runs without verified progress before it stops.
  noProgressRuns: number;
  // Where the owner is told when a guard stops the job: a note in 00-inbox/escalations/.
  escalate: "inbox";
};

// Running totals the guard is checked against.
export type GuardUsage = {
  runs: number;
  tokens: number;
  noProgress: number;
};

export const GUARD_FLAGS =
  "--verify <cmd> --max-runs N --budget-tokens N --no-progress N --escalate inbox";

const positiveInt = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

// What is missing or invalid; empty when the guard is complete.
export function guardProblems(guard: Partial<LoopGuard> | undefined): string[] {
  const problems: string[] = [];
  if (!guard?.verify?.trim()) problems.push("verify: a verifier command");
  if (!positiveInt(guard?.maxRuns)) problems.push("max-runs: a hard cap");
  if (!positiveInt(guard?.budgetTokens))
    problems.push("budget-tokens: a token budget");
  if (!positiveInt(guard?.noProgressRuns))
    problems.push("no-progress: a no-progress exit");
  if (guard?.escalate !== "inbox")
    problems.push("escalate: human escalation (inbox)");
  return problems;
}

export function assertGuard(
  guard: Partial<LoopGuard> | undefined,
): asserts guard is LoopGuard {
  const problems = guardProblems(guard);
  if (problems.length)
    throw new Error(
      `Refused: a recurring agent run must declare ${problems.join("; ")}. Pass ${GUARD_FLAGS}.`,
    );
}

// Why the guard stops the job now, or null to keep going.
export function guardStop(guard: LoopGuard, usage: GuardUsage): string | null {
  if (usage.runs >= guard.maxRuns)
    return `hard cap reached: ${usage.runs} of ${guard.maxRuns} runs`;
  if (usage.tokens >= guard.budgetTokens)
    return `token budget used: ${usage.tokens} of ${guard.budgetTokens}`;
  if (usage.noProgress >= guard.noProgressRuns)
    return `no verified progress in ${usage.noProgress} runs in a row`;
  return null;
}

// Parses the guard flags out of an argument list; returns the guard and the remaining arguments.
export function parseGuardFlags(args: string[]): {
  guard: Partial<LoopGuard>;
  rest: string[];
} {
  const guard: Partial<LoopGuard> = {};
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--verify") guard.verify = value;
    else if (flag === "--max-runs") guard.maxRuns = Number(value);
    else if (flag === "--budget-tokens") guard.budgetTokens = Number(value);
    else if (flag === "--no-progress") guard.noProgressRuns = Number(value);
    else if (flag === "--escalate") guard.escalate = value as "inbox";
    else {
      rest.push(flag);
      continue;
    }
    index += 1;
  }
  return { guard, rest };
}
