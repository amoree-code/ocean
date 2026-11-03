import {
  readCallLedger,
  summarizeCallLedger,
} from "@ocean/services/infrastructure/mcp/call-ledger.js";
import {
  applyClients,
  confirmClient,
  defaultClientEnv,
  type EvidenceLabel,
  planClients,
  recordVerification,
  repairClients,
  restoreClients,
  temporaryEntryProblem,
  verifyClient,
} from "../../application/clients/clients.js";
import {
  applyHooks,
  planHooks,
  restoreHooks,
} from "../../application/clients/hooks.js";
import {
  applyNative,
  planNative,
  restoreNative,
} from "../../application/clients/native.js";
import {
  applyOpencodePlugin,
  planOpencodePlugin,
  restoreOpencodePlugin,
} from "../../application/clients/opencode-plugin.js";

const usage =
  "Usage: ocean clients detect|plan [--json] | apply [--client <id>…] [--yes] | verify [<id>…] | confirm <id>… --label in-app|headless|connected|blocked [--via <evidence>] [--reason <why>] | ledger | repair | restore [--batch <id>]";

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
    // `apply` refuses a temporary engine; the plan says so up front (T-300).
    const problem = temporaryEntryProblem(defaultClientEnv().entry);
    if (problem && action === "plan")
      console.error(`Warning: apply would refuse this plan — ${problem}`);
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
        for (const native of await planNative())
          console.log(
            `${`${native.client} memory`.padEnd(15)} ${native.status.padEnd(14)} ${
              native.setting
                ? `${native.file} ${native.setting}`
                : (native.reason ?? "")
            }${native.setting && native.reason ? ` (${native.reason})` : ""}`,
          );
      if (action === "plan")
        for (const hook of await planHooks())
          console.log(
            `${`${hook.client} hook`.padEnd(15)} ${hook.status.padEnd(14)} ${hook.file} ${hook.event}${
              hook.reason ? ` (${hook.reason})` : ""
            }${hook.snippet ? `; add ${hook.snippet}` : ""}`,
          );
      if (action === "plan")
        for (const plugin of await planOpencodePlugin())
          console.log(
            `${"opencode hook".padEnd(15)} ${plugin.status.padEnd(14)} ${plugin.file} plugin${
              plugin.reason ? ` (${plugin.reason})` : ""
            }`,
          );
      return;
    }
    result =
      action === "detect"
        ? plans.filter((plan) => plan.installed)
        : {
            clients: plans,
            hooks: await planHooks(),
            plugins: await planOpencodePlugin(),
            native: await planNative(),
          };
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
      const native = (await planNative()).filter(
        (plan) =>
          plan.status === "change" &&
          (!clients.length || clients.includes(plan.client)),
      );
      const plugins = (await planOpencodePlugin()).filter(
        (plan) =>
          plan.status === "change" &&
          (!clients.length || clients.includes(plan.client)),
      );
      console.log(
        JSON.stringify(
          { dryRun: true, pending, hooks, plugins, native },
          null,
          2,
        ),
      );
      console.error("Dry run: pass --yes to write these client configs.");
      return;
    }
    const selected = clients.length ? clients : undefined;
    const applied = await applyClients({ clients: selected });
    result = {
      ...applied,
      hooks: (await applyHooks({ clients: selected, batch: applied.batch }))
        .results,
      plugins: (
        await applyOpencodePlugin({ clients: selected, batch: applied.batch })
      ).results,
      native: (await applyNative({ clients: selected, batch: applied.batch }))
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
    for (const id of targets) {
      const check = await verifyClient(id);
      await recordVerification(id, check.ok);
      (result as unknown[]).push(check);
    }
  } else if (action === "confirm") {
    const flags = ["--label", "--via", "--reason"];
    const ids = rest.filter(
      (arg, index) => !arg.startsWith("--") && !flags.includes(rest[index - 1]),
    );
    const label = values("--label")[0];
    if (!ids.length || !label)
      throw new Error(
        "Usage: ocean clients confirm <id>… --label in-app|headless|connected|blocked [--via <evidence>] [--reason <why>]",
      );
    for (const id of ids)
      await confirmClient(id, {
        label: label as EvidenceLabel,
        via: values("--via")[0],
        reason: values("--reason")[0],
      });
    result = { confirmed: ids, label };
  } else if (action === "ledger")
    // Which client called which Ocean tool, and when last — the in-app evidence (T-307).
    result = summarizeCallLedger(await readCallLedger());
  else if (action === "repair") result = await repairClients();
  else if (action === "restore") {
    const restored = await restoreClients({ batch: values("--batch")[0] });
    result = restored.batch
      ? {
          ...restored,
          hooks: await restoreHooks({ batch: restored.batch }),
          plugins: await restoreOpencodePlugin({ batch: restored.batch }),
          native: await restoreNative({ batch: restored.batch }),
        }
      : restored;
  } else {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}
