import {
  applyClients,
  planClients,
  repairClients,
  restoreClients,
  verifyClient,
} from "../../application/clients/clients.js";
import {
  applyHooks,
  planHooks,
  restoreHooks,
} from "../../application/clients/hooks.js";

const usage =
  "Usage: ocean clients detect|plan [--json] | apply [--client <id>…] [--yes] | verify [<id>…] | repair | restore [--batch <id>]";

// `ocean clients` (T-296 P2/P3b): every installed AI client's `ocean` MCP entry and, where the
// client has a verified session-start event, Ocean's session hook. `apply` shows the plan until
// --yes; `repair` only re-applies clients already approved; `restore` undoes an apply batch
// (entries and hooks) from the journal.
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
      if (action === "plan")
        for (const hook of await planHooks())
          console.log(
            `${`${hook.client} hook`.padEnd(15)} ${hook.status.padEnd(14)} ${hook.file} SessionStart${
              hook.reason ? ` (${hook.reason})` : ""
            }${hook.snippet ? `; add ${hook.snippet}` : ""}`,
          );
      return;
    }
    result =
      action === "detect"
        ? plans.filter((plan) => plan.installed)
        : { clients: plans, hooks: await planHooks() };
  } else if (action === "apply") {
    const clients = values("--client");
    if (!rest.includes("--yes")) {
      const pending = (await planClients()).filter(
        (plan) =>
          plan.status === "change" &&
          (!clients.length || clients.includes(plan.client)),
      );
      const hooks = (await planHooks()).filter(
        (hook) =>
          hook.status === "change" &&
          (!clients.length || clients.includes(hook.client)),
      );
      console.log(JSON.stringify({ dryRun: true, pending, hooks }, null, 2));
      console.error("Dry run: pass --yes to write these client configs.");
      return;
    }
    const selected = clients.length ? clients : undefined;
    const applied = await applyClients({ clients: selected });
    result = {
      ...applied,
      hooks: (await applyHooks({ clients: selected, batch: applied.batch }))
        .results,
    };
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
  else if (action === "restore") {
    const restored = await restoreClients({ batch: values("--batch")[0] });
    result = restored.batch
      ? { ...restored, hooks: await restoreHooks({ batch: restored.batch }) }
      : restored;
  } else {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}
