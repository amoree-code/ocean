import {
  CORE_RULES,
  policyCatalog,
  policyNames,
  readCoreRules,
  readRules,
} from "@ocean/core/shared/charter.js";

export async function runPolicyCommand(name = "list"): Promise<void> {
  const names = await policyNames();
  if (name === "list") {
    // Name, triggers and digest: what the prompt hook routes on (T-339 P1).
    const catalog = await policyCatalog();
    console.log(
      JSON.stringify(
        {
          policies: catalog.map(({ name, triggers, digest }) => ({
            name,
            triggers,
            digest,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (name === "validate") {
    // Every policy carries triggers and a digest of at most 200 bytes, or none is routed.
    const problems = (await policyCatalog())
      .filter((entry) => entry.problems.length)
      .map(({ name, problems }) => ({ name, problems }));
    console.log(
      JSON.stringify(
        { ok: problems.length === 0, policies: names.length, problems },
        null,
        2,
      ),
    );
    if (problems.length) process.exitCode = 1;
    return;
  }
  if (name === "doctor") {
    const core = (await readCoreRules()) ?? "";
    const referenced = new Set(
      [...core.matchAll(/ocean policy ([a-z-]+)/g)]
        .map((match) => match[1])
        .filter((item) => item !== "list"),
    );
    const missing = [...referenced].filter((item) => !names.includes(item));
    console.log(
      JSON.stringify(
        { ok: missing.length === 0, policies: names.length, missing },
        null,
        2,
      ),
    );
    if (missing.length) process.exitCode = 1;
    return;
  }
  if (name === CORE_RULES) throw new Error(`Unknown policy: ${name}`);
  process.stdout.write(await readRules(name));
}

export async function runLifecycleCommand(args: string[]): Promise<void> {
  const taskIndex = args.indexOf("--task");
  const taskId = taskIndex >= 0 ? args[taskIndex + 1] : undefined;
  const verificationIndex = args.indexOf("--verification");
  const verification =
    verificationIndex >= 0 ? args[verificationIndex + 1] : undefined;
  const complete = args.includes("--complete");
  const decision =
    complete && verification === "passed" ? "CHECKPOINT" : "CONTINUE";
  const result = {
    decision,
    taskId: taskId ?? null,
    complete,
    verification: verification ?? "unknown",
    reason:
      decision === "CHECKPOINT"
        ? "completed work with passing verification must be persisted"
        : "no verified completion boundary was supplied",
  };
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.decision}: ${result.reason}`);
}
