import {
  applyClients,
  planClients,
  repairClients,
  restoreClients,
  verifyClient,
} from "../../application/clients/clients.js";

const usage =
  "Usage: ocean clients detect|plan [--json] | apply [--client <id>…] [--yes] | verify [<id>…] | repair | restore [--batch <id>]";

// `ocean clients` (T-296 P2): every installed AI client's `ocean` MCP entry. `apply` shows the
// plan until --yes; `repair` only re-applies clients already approved; `restore` undoes an apply
// batch from the journal.
export async function runClientsCommand(args: string[]): Promise<void> {
  const [action = "detect", ...rest] = args;
  const json = rest.includes("--json");
  const values = (flag: string) =>
    rest.flatMap((arg, index) => (rest[index - 1] === flag ? [arg] : []));
  let result: unknown;
  if (action === "detect" || action === "plan") {
    const plans = await planClients();
    if (!json) {
      for (const plan of plans) {
        if (action === "detect" && !plan.installed) continue;
        const ops = plan.ops.map((op) => `${op.kind} ${op.key}`).join(", ");
        console.log(
          `${plan.client.padEnd(15)} ${plan.status.padEnd(14)} ${plan.tier.padEnd(13)} ${
            plan.installed ? plan.evidence.join("; ") : "not installed"
          }${ops ? ` → ${ops}` : ""}${plan.reason ? ` (${plan.reason})` : ""}`,
        );
      }
      return;
    }
    result =
      action === "detect" ? plans.filter((plan) => plan.installed) : plans;
  } else if (action === "apply") {
    const clients = values("--client");
    if (!rest.includes("--yes")) {
      const pending = (await planClients()).filter(
        (plan) =>
          plan.status === "change" &&
          (!clients.length || clients.includes(plan.client)),
      );
      console.log(JSON.stringify({ dryRun: true, pending }, null, 2));
      console.error("Dry run: pass --yes to write these client configs.");
      return;
    }
    result = await applyClients({
      clients: clients.length ? clients : undefined,
    });
  } else if (action === "verify") {
    const ids = rest.filter((arg) => !arg.startsWith("--"));
    const targets = ids.length
      ? ids
      : (await planClients())
          .filter((plan) => plan.installed && plan.status === "current")
          .map((plan) => plan.client);
    result = [];
    for (const id of targets)
      (result as unknown[]).push(await verifyClient(id));
  } else if (action === "repair") result = await repairClients();
  else if (action === "restore")
    result = await restoreClients({ batch: values("--batch")[0] });
  else {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}
