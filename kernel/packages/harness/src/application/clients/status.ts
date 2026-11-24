import type { ClientPlan } from "./clients.js";
import type { DesktopWatcherPlan } from "./desktop-watcher.js";
import type { HookPlan } from "./hooks.js";
import type { NativePlan } from "./native.js";
import type { OpencodePluginPlan } from "./opencode-plugin.js";
import { clientAdapter, mcpClientOf } from "./registry.js";

// `ocean clients status` (T-328 P1): one row per installed client across the four pillars —
// connected (Ocean in its MCP config), triggered (something makes it call Ocean), captured (its
// own memory flows into Ocean) and used (the call ledger proves its model called a tool). Pure:
// the caller passes the plans and the ledger, so the verdicts are testable without a home.

export type Pillar = "yes" | "partial" | "no" | "n/a" | "unknown";
export type Trigger = "hook" | "plugin" | "instructions" | "none";

export type ClientStatusRow = {
  client: string;
  label: string;
  tier: ClientPlan["tier"];
  connected: Pillar;
  trigger: Trigger;
  triggered: Pillar;
  captured: Pillar;
  // Newest ledger call per mode ("" when the client has one mode), within the retention.
  lastCall: Record<string, string>;
  recentCalls: number;
  notes: string[];
};

export type ClientStatusReport = {
  window: { days: number; since: string };
  clients: ClientStatusRow[];
  // Ledger client names no adapter claims: a registry gap, not noise.
  unattributed: { name: string; calls: number; last: string }[];
  summary: { installed: number; working: number };
};

export type StatusInput = {
  plans: ClientPlan[];
  hooks: HookPlan[];
  plugins: OpencodePluginPlan[];
  native: NativePlan[];
  watcher: DesktopWatcherPlan[];
  // Whether the Claude account lists the ocean-memory skill; undefined when nothing here
  // can tell (no Desktop plugin list).
  chatPlugin?: { added: boolean | undefined };
  calls: { ts: string; client: string; ok: boolean }[];
  now?: Date;
  days?: number;
};

const DAY_MS = 86_400_000;

function allCurrent(statuses: string[]): Pillar {
  if (!statuses.length) return "n/a";
  const current = statuses.filter((status) => status === "current").length;
  if (current === statuses.length) return "yes";
  return current ? "partial" : "no";
}

function connectedOf(plan: ClientPlan): Pillar {
  if (plan.tier !== "supported") return "n/a";
  if (plan.status === "current") return "yes";
  if (plan.status === "change") return "no";
  return "partial";
}

function capturedOf(plan: ClientPlan, native: NativePlan | undefined): Pillar {
  if (native) {
    if (["current", "capture", "harvest"].includes(native.status)) return "yes";
    if (native.status === "manual") return "partial";
    return "no";
  }
  if (plan.nativeMemory === "none") return "n/a";
  if (plan.nativeMemory === "unknown") return "unknown";
  return "no";
}

export function buildClientStatus(input: StatusInput): ClientStatusReport {
  const now = input.now ?? new Date();
  const days = input.days ?? 7;
  const since = new Date(now.getTime() - days * DAY_MS).toISOString();

  const last = new Map<string, Record<string, string>>();
  const recent = new Map<string, number>();
  const recentModes = new Set<string>();
  const unattributed = new Map<string, { calls: number; last: string }>();
  for (const call of input.calls) {
    if (!call.ok) continue;
    const known = mcpClientOf(call.client);
    if (!known) {
      const row = unattributed.get(call.client) ?? { calls: 0, last: call.ts };
      row.calls += 1;
      if (call.ts > row.last) row.last = call.ts;
      unattributed.set(call.client, row);
      continue;
    }
    const modes = last.get(known.id) ?? {};
    const mode = known.mode ?? "";
    if (!modes[mode] || call.ts > modes[mode]) modes[mode] = call.ts;
    last.set(known.id, modes);
    if (call.ts >= since) {
      recent.set(known.id, (recent.get(known.id) ?? 0) + 1);
      recentModes.add(`${known.id}\u0000${mode}`);
    }
  }

  const clients: ClientStatusRow[] = [];
  for (const plan of input.plans) {
    if (!plan.installed) continue;
    const notes: string[] = [];
    const hooks = input.hooks.filter((hook) => hook.client === plan.client);
    const plugins = input.plugins.filter(
      (plugin) => plugin.client === plan.client,
    );
    const lastCall = last.get(plan.client) ?? {};
    const recentCalls = recent.get(plan.client) ?? 0;
    const connected = connectedOf(plan);

    let trigger: Trigger;
    let triggered: Pillar;
    if (hooks.length) {
      trigger = "hook";
      triggered = allCurrent(hooks.map((hook) => hook.status));
      for (const hook of hooks)
        if (hook.status !== "current")
          notes.push(`${hook.event} hook ${hook.status}`);
    } else if (plugins.length) {
      trigger = "plugin";
      triggered = allCurrent(plugins.map((plugin) => plugin.status));
    } else if (connected === "yes") {
      // No start event to hook: only the server instructions ask the model to call Ocean, so
      // the ledger is the only proof that they work.
      trigger = "instructions";
      // A client with several modes (Desktop chat and agent) is only fully triggered when
      // every mode called; one quiet mode is the gap this view exists to show.
      const modes = (clientAdapter(plan.client).mcpClients ?? [])
        .map((item) => item.mode)
        .filter((mode): mode is string => Boolean(mode));
      const quiet = modes.filter(
        (mode) => !recentModes.has(`${plan.client}\u0000${mode}`),
      );
      if (!recentCalls) {
        triggered = "no";
        notes.push(`no Ocean call in ${days} days`);
      } else if (quiet.length) {
        triggered = "partial";
        for (const mode of quiet)
          notes.push(`${mode}: no Ocean call in ${days} days`);
      } else triggered = "yes";
    } else {
      trigger = "none";
      triggered = plan.tier === "supported" ? "no" : "n/a";
    }

    const native = input.native.find((item) => item.client === plan.client);
    const captured = capturedOf(plan, native);
    if (native?.status === "uncaptured" && native.reason)
      notes.push(native.reason);
    const watcher = input.watcher.find((item) => item.client === plan.client);
    if (watcher && watcher.status !== "current")
      notes.push(`chat watcher ${watcher.status}`);
    if (plan.client === "claude-desktop" && input.chatPlugin?.added === false)
      notes.push(
        "ocean-memory skill not in your Claude account: run `ocean clients chat-plugin`",
      );
    if (plan.tier !== "supported" && plan.reason) notes.push(plan.reason);

    clients.push({
      client: plan.client,
      label: plan.label,
      tier: plan.tier,
      connected,
      trigger,
      triggered,
      captured,
      lastCall,
      recentCalls,
      notes,
    });
  }

  const working = clients.filter(
    (row) =>
      row.connected === "yes" &&
      row.triggered === "yes" &&
      ["yes", "n/a"].includes(row.captured),
  ).length;

  return {
    window: { days, since },
    clients,
    unattributed: [...unattributed.entries()]
      .map(([name, row]) => ({ name, ...row }))
      .sort((a, b) => b.last.localeCompare(a.last)),
    summary: { installed: clients.length, working },
  };
}

const MARK: Record<Pillar, string> = {
  yes: "✓",
  partial: "~",
  no: "✗",
  "n/a": "–",
  unknown: "?",
};

function age(iso: string, now: Date): string {
  const minutes = Math.max(
    0,
    Math.round((now.getTime() - Date.parse(iso)) / 60_000),
  );
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function lastCallText(row: ClientStatusRow, now: Date): string {
  const modes = Object.entries(row.lastCall);
  if (!modes.length) return "never";
  return modes
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mode, ts]) => (mode ? `${mode} ${age(ts, now)}` : age(ts, now)))
    .join(" · ");
}

// The terminal view: a fixed-width table, a footer for unattributed callers, one summary line.
export function formatClientStatus(
  report: ClientStatusReport,
  now = new Date(),
): string {
  const header = [
    "client".padEnd(16),
    "connected".padEnd(10),
    "trigger".padEnd(13),
    "triggered".padEnd(10),
    "captured".padEnd(9),
    "last call",
  ].join(" ");
  const lines = [header];
  for (const row of report.clients) {
    lines.push(
      [
        row.client.padEnd(16),
        MARK[row.connected].padEnd(10),
        row.trigger.padEnd(13),
        MARK[row.triggered].padEnd(10),
        MARK[row.captured].padEnd(9),
        lastCallText(row, now),
      ].join(" "),
    );
    for (const note of row.notes) lines.push(`${"".padEnd(17)}↳ ${note}`);
  }
  if (report.unattributed.length) {
    lines.push("");
    lines.push(
      `Unattributed callers (no client claims them): ${report.unattributed
        .map((row) => `${row.name} (${row.calls}, ${age(row.last, now)})`)
        .join(", ")}`,
    );
  }
  lines.push("");
  lines.push(
    `${report.summary.working} of ${report.summary.installed} installed clients fully working (connected, triggered, captured). Window: ${report.window.days} days.`,
  );
  return lines.join("\n");
}
