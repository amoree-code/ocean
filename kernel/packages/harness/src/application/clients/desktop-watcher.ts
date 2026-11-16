import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { sessionFactsEnabled } from "@ocean/brain/memory/memory-audit.js";
import { desktopFactsLastRunFile } from "@ocean/loop/hooks/desktop-facts.js";
import {
  appendJournal,
  type ClientEnv,
  type ClientFinding,
  defaultClientEnv,
  edit,
  newBatch,
  planClients,
  readJournal,
  temporaryEntryProblem,
} from "./clients.js";
import { oceanInvocation } from "./opencode-plugin.js";

// Claude Desktop's plain chat has no hooks (T-315), so a per-user LaunchAgent stands in for
// one: launchd runs `ocean desktop capture` when the app writes its local chat store
// (WatchPaths, at most once per ThrottleInterval) and every StartInterval, which catches a
// conversation that went quiet after the last write. The capture itself skips conversations
// still being written. The plist is Ocean's alone: written whole, journaled, loaded with
// launchctl, unloaded and removed on restore. It is offered only on macOS, with Claude Desktop
// installed and session facts on — the same consent that turns on capture for every client.

export const DESKTOP_WATCHER_LABEL = "com.ocean.desktop-capture";
export const DESKTOP_WATCHER_FILE = `Library/LaunchAgents/${DESKTOP_WATCHER_LABEL}.plist`;
const CLIENT = "claude-desktop";
const KEY = "desktop-watcher";
const THROTTLE_SECONDS = 300;
const INTERVAL_SECONDS = 900;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const xml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export function desktopStoreDir(home: string): string {
  return path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "IndexedDB",
    "https_claude.ai_0.indexeddb.leveldb",
  );
}

export function desktopWatcherPlist(env: ClientEnv): string {
  const args = [...oceanInvocation(env), "desktop", "capture"];
  const strings = (items: string[]) =>
    items.map((item) => `<string>${xml(item)}</string>`).join("");
  // launchd starts jobs with a bare PATH; the capture's model call needs the client's CLI.
  const pathValue = [...new Set([...env.pathDirs, "/usr/bin", "/bin"])].join(
    ":",
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by \`ocean clients apply\`; \`ocean clients restore\` removes it. -->
<plist version="1.0"><dict>
<key>Label</key><string>${DESKTOP_WATCHER_LABEL}</string>
<key>ProgramArguments</key><array>${strings(args)}</array>
<key>WatchPaths</key><array>${strings([desktopStoreDir(env.home)])}</array>
<key>StartInterval</key><integer>${INTERVAL_SECONDS}</integer>
<key>ThrottleInterval</key><integer>${THROTTLE_SECONDS}</integer>
<key>RunAtLoad</key><false/>
<key>ProcessType</key><string>Background</string>
<key>LowPriorityIO</key><true/>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(pathValue)}</string></dict>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`;
}

export type DesktopWatcherPlan = {
  client: typeof CLIENT;
  file: string;
  status: "current" | "change" | "manual" | "off";
  reason?: string;
};

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function planText(text: string | null, want: string): DesktopWatcherPlan {
  const plan = { client: CLIENT, file: `~/${DESKTOP_WATCHER_FILE}` } as const;
  if (text === want) return { ...plan, status: "current" };
  if (
    text === null ||
    text.includes(`<string>${DESKTOP_WATCHER_LABEL}</string>`)
  )
    return { ...plan, status: "change" };
  return {
    ...plan,
    status: "manual",
    reason: "a plist Ocean did not write has this name",
  };
}

type Options = {
  env?: ClientEnv;
  platform?: NodeJS.Platform;
  enabled?: () => Promise<boolean>;
};

export async function planDesktopWatcher(
  options: Options = {},
): Promise<DesktopWatcherPlan[]> {
  const env = options.env ?? defaultClientEnv();
  if ((options.platform ?? process.platform) !== "darwin") return [];
  const installed = (await planClients(env)).some(
    (plan) => plan.client === CLIENT && plan.installed,
  );
  if (!installed) return [];
  const text = await readIfPresent(path.join(env.home, DESKTOP_WATCHER_FILE));
  if (!(await (options.enabled ?? sessionFactsEnabled)()))
    return [
      {
        client: CLIENT,
        file: `~/${DESKTOP_WATCHER_FILE}`,
        status: text === null ? "off" : "current",
        reason: "session facts are off",
      },
    ];
  return [planText(text, desktopWatcherPlist(env))];
}

type Run = (command: string, args: string[]) => Promise<unknown>;
const runCommand: Run = (command, args) => promisify(execFile)(command, args);
const domain = () => `gui/${process.getuid?.() ?? ""}`;

// Writes the plist and (re)loads the job. Loading is best effort: the plist stays, and the next
// login loads it.
export async function applyDesktopWatcher(
  options: Options & {
    clients?: string[];
    batch?: string;
    durable?: boolean;
    run?: Run;
  } = {},
): Promise<{ batch: string; results: { client: string; result: string }[] }> {
  const env = options.env ?? defaultClientEnv();
  const batch = options.batch ?? newBatch();
  if (options.clients && !options.clients.includes(CLIENT))
    return { batch, results: [] };
  const [plan] = await planDesktopWatcher({ ...options, env });
  if (plan?.status !== "change") return { batch, results: [] };
  if (options.durable ?? !options.env) {
    const problem = temporaryEntryProblem(env.entry);
    if (problem)
      throw new Error(`Refusing to add the Desktop watcher: ${problem}`);
  }
  const want = desktopWatcherPlist(env);
  const file = path.join(env.home, DESKTOP_WATCHER_FILE);
  const result = await edit(
    file,
    (text) => {
      const current = text === "" ? null : text;
      if (planText(current, want).status !== "change") return null;
      return {
        next: want,
        entries: [
          {
            client: CLIENT,
            file: DESKTOP_WATCHER_FILE,
            op: "hook-add",
            key: KEY,
            before: current === null ? null : { sha256: sha(current) },
            after: { sha256: sha(want) },
          },
        ],
      };
    },
    batch,
  );
  if (result === "written") {
    const run = options.run ?? runCommand;
    await run("launchctl", [
      "bootout",
      `${domain()}/${DESKTOP_WATCHER_LABEL}`,
    ]).catch(() => {});
    const loaded = await run("launchctl", ["bootstrap", domain(), file]).then(
      () => true,
      () => false,
    );
    return {
      batch,
      results: [
        {
          client: CLIENT,
          result: loaded ? "written" : "written (loads at next login)",
        },
      ],
    };
  }
  return { batch, results: [{ client: CLIENT, result }] };
}

// Unloads and removes the plist one apply batch wrote, unless it changed since (a conflict).
export async function restoreDesktopWatcher(options: {
  batch: string;
  env?: ClientEnv;
  run?: Run;
}): Promise<{ restored: string[]; conflicts: string[] }> {
  const env = options.env ?? defaultClientEnv();
  const entries = (await readJournal()).filter(
    (entry) =>
      entry.batch === options.batch &&
      entry.client === CLIENT &&
      entry.key === KEY &&
      !entry.restoreOf,
  );
  const restored: string[] = [];
  const conflicts: string[] = [];
  for (const entry of entries) {
    const file = path.join(env.home, entry.file);
    const text = await readIfPresent(file);
    const after = (entry.after as { sha256?: string } | null)?.sha256;
    if (text === null || sha(text) !== after) {
      conflicts.push(`${CLIENT}:${KEY}`);
      continue;
    }
    await (options.run ?? runCommand)("launchctl", [
      "bootout",
      `${domain()}/${DESKTOP_WATCHER_LABEL}`,
    ]).catch(() => {});
    await unlink(file);
    await appendJournal([
      {
        ...entry,
        batch: newBatch(),
        ts: new Date().toISOString(),
        restoreOf: options.batch,
      },
    ]);
    restored.push(`${CLIENT}:${KEY}`);
  }
  return { restored, conflicts };
}

type LastRun = {
  at?: string;
  status?: string;
  code?: string;
  reason?: string;
  candidates?: number;
};

// Doctor view: the watcher is wanted but missing or stale; the last capture run failed to read
// the store (the format changed with an app update); or the last run, when it was.
export async function desktopWatcherFindings(
  options: Options & { now?: Date } = {},
): Promise<ClientFinding[]> {
  const plans = await planDesktopWatcher(options);
  const plan = plans[0];
  if (!plan || plan.status === "off") return [];
  const findings: ClientFinding[] = [];
  if (plan.status === "change")
    findings.push({
      code: "DESKTOP_WATCHER_MISSING",
      severity: "WARN",
      message:
        "Claude Desktop chat is not captured: its watcher is missing or out of date — run `ocean clients apply --yes`",
      fixable: true,
    });
  else if (plan.status === "manual")
    findings.push({
      code: "DESKTOP_WATCHER_MANUAL",
      severity: "WARN",
      message: `Claude Desktop watcher: ${plan.reason} (${plan.file})`,
      fixable: false,
    });
  let last: LastRun | null = null;
  try {
    last = JSON.parse(
      await readFile(desktopFactsLastRunFile(), "utf8"),
    ) as LastRun;
  } catch {
    last = null;
  }
  if (last?.code)
    findings.push({
      code: last.code,
      severity: "WARN",
      message: `Claude Desktop chat could not be read at ${last.at}: ${last.reason ?? "unknown"} — the app's local format may have changed with an update; Desktop facts are not captured until Ocean is updated`,
      fixable: false,
    });
  else if (plan.status === "current")
    findings.push({
      code: "DESKTOP_WATCHER_OK",
      severity: "OK",
      message: last?.at
        ? `Claude Desktop chat watcher loaded; last run ${last.at} (${last.status}, ${last.candidates ?? 0} candidate(s))`
        : "Claude Desktop chat watcher installed; no run recorded yet",
      fixable: false,
    });
  return findings;
}
