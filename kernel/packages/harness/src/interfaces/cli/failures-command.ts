import { openSessionStoreReadOnly } from "@ocean/loop/infrastructure/persistence/session-store.js";
import {
  ABSORB_MECHANISMS,
  climbFailure,
  type FailureStatus,
  failureRecurrence,
  listFailures,
  openFailure,
  RECURRENCE_WINDOW_DAYS,
  type Rung,
  setFailureStatus,
} from "@ocean/services/journey/failures.js";
import { signatureStats } from "@ocean/services/journey/telemetry.js";

const USAGE = [
  "Usage: ocean failures [list] [--json]",
  "       ocean failures open <id> <signature> --title <text> --mechanism <why it happens> [--lesson <id>] [--rung lesson|doctor|test] [--fix <text>] [--guardrail <text>]",
  `       ocean failures status <id> fix-landing|open|absorbed --by ${ABSORB_MECHANISMS.join("|")}|superseded-by <id>`,
  "       ocean failures climb <id>",
].join("\n");

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

// `ocean failures` (T-323): failure records in 05-knowledge/failures/, each tracked by its
// telemetry signature. Every change goes through code, one field at a time; `climb` is the
// owner's approval of a guardrail climb that telemetry proposed.
export async function runFailuresCommand(args: string[]): Promise<void> {
  const [action = "list", id, ...rest] = args;
  if (action === "list" || action === "--json") {
    const store = await openSessionStoreReadOnly();
    let recurrence: ReturnType<typeof failureRecurrence>;
    try {
      recurrence = failureRecurrence(
        await listFailures(),
        signatureStats(
          store.list(),
          (session) => store.listEvents(session),
          "",
        ),
      );
    } finally {
      store.close();
    }
    if (args.includes("--json")) {
      console.log(JSON.stringify(recurrence, null, 2));
      return;
    }
    if (!recurrence.length) console.log("No failure records with a signature.");
    for (const entry of recurrence)
      console.log(
        `${entry.id}  ${entry.status}  rung ${entry.rung}  ${entry.recent} sessions in ${RECURRENCE_WINDOW_DAYS} d${entry.cleanDays === null ? "" : `  clean ${entry.cleanDays} d`}  ${entry.signature}`,
      );
    return;
  }
  if (!id) throw new Error(USAGE);
  if (action === "open") {
    const [signature] = rest;
    const title = option(rest, "--title");
    const mechanism = option(rest, "--mechanism");
    if (!signature || !title || !mechanism) throw new Error(USAGE);
    console.log(
      JSON.stringify(
        await openFailure({
          id,
          title,
          signature,
          mechanism,
          lesson: option(rest, "--lesson"),
          rung: option(rest, "--rung") as Rung | undefined,
          fix: option(rest, "--fix"),
          guardrail: option(rest, "--guardrail"),
        }),
        null,
        2,
      ),
    );
  } else if (action === "status") {
    const [next, target] = rest;
    if (!next) throw new Error(USAGE);
    const status =
      next === "superseded-by" && target
        ? (`superseded-by ${target}` as const)
        : (next as FailureStatus);
    console.log(
      JSON.stringify(
        await setFailureStatus(id, status, { by: option(rest, "--by") }),
        null,
        2,
      ),
    );
  } else if (action === "climb")
    console.log(JSON.stringify(await climbFailure(id), null, 2));
  else throw new Error(USAGE);
}
