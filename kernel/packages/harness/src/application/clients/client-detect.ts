import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { atomicWrite } from "@ocean/core/shared/fs-utils.js";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import {
  appendJournal,
  type ClientEnv,
  type ClientFinding,
  type ClientPlan,
  defaultClientEnv,
  edit,
  newBatch,
  planClients,
  readJournal,
  temporaryEntryProblem,
} from "./clients.js";
import { oceanInvocation } from "./opencode-plugin.js";
import { CLIENT_ADAPTERS } from "./registry.js";

// Auto-detect (T-328 P7): a per-user LaunchAgent runs `ocean clients detect --new --notify` when
// an app lands in /Applications or ~/Applications, and every hour for CLIs installed elsewhere.
// A client that appears after the detector was set up and that Ocean can wire gets one macOS
// notification naming the command that connects it. It only offers: connecting a client edits
// its config, which stays the owner's yes. Every client present when the detector is applied is
// recorded as seen, so it never notifies about what the owner already reviewed. The plist is
// Ocean's alone: written whole, journaled, loaded with launchctl, unloaded and removed on restore.

export const CLIENT_DETECT_LABEL = "com.ocean.client-detect";
export const CLIENT_DETECT_FILE = `Library/LaunchAgents/${CLIENT_DETECT_LABEL}.plist`;
// Not a client: the detector serves every client, so `apply --client <id>` never adds it.
const OWNER = "ocean";
const KEY = "client-detect";
const THROTTLE_SECONDS = 60;
const INTERVAL_SECONDS = 3600;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const xml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

// launchd starts jobs with a bare PATH, and binaries are half of detection. The folders that hold
// a known client CLI are kept, resolved through symlinks so a per-shell folder (fnm_multishells/
// <pid>) never makes the plist differ from one shell to the next; the usual install folders are
// added so a CLI installed later into one of them is still found.
export function detectPathDirs(env: ClientEnv): string[] {
  const binaries = CLIENT_ADAPTERS.flatMap(
    (adapter) => adapter.detect.binaries ?? [],
  );
  const found: string[] = [];
  for (const dir of env.pathDirs)
    for (const name of binaries)
      try {
        accessSync(path.join(dir, name), constants.X_OK);
        found.push(realpathSync(dir));
        break;
      } catch {}
  const usual = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(env.home, ".local", "bin"),
    path.join(env.home, ".bun", "bin"),
    path.join(env.home, ".npm-global", "bin"),
  ];
  return [...new Set([...found, ...usual, "/usr/bin", "/bin"])];
}

export function clientDetectPlist(env: ClientEnv): string {
  const args = [
    ...oceanInvocation(env),
    "clients",
    "detect",
    "--new",
    "--notify",
  ];
  const strings = (items: string[]) =>
    items.map((item) => `<string>${xml(item)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by \`ocean clients apply\`; \`ocean clients restore\` removes it. -->
<plist version="1.0"><dict>
<key>Label</key><string>${CLIENT_DETECT_LABEL}</string>
<key>ProgramArguments</key><array>${strings(args)}</array>
<key>WatchPaths</key><array>${strings(env.appDirs)}</array>
<key>StartInterval</key><integer>${INTERVAL_SECONDS}</integer>
<key>ThrottleInterval</key><integer>${THROTTLE_SECONDS}</integer>
<key>RunAtLoad</key><false/>
<key>ProcessType</key><string>Background</string>
<key>LowPriorityIO</key><true/>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(detectPathDirs(env).join(":"))}</string></dict>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`;
}

export type ClientDetectPlan = {
  client: typeof OWNER;
  file: string;
  status: "current" | "change" | "manual";
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

function planText(text: string | null, want: string): ClientDetectPlan {
  const plan = { client: OWNER, file: `~/${CLIENT_DETECT_FILE}` } as const;
  if (text === want) return { ...plan, status: "current" };
  if (text === null || text.includes(`<string>${CLIENT_DETECT_LABEL}</string>`))
    return { ...plan, status: "change" };
  return {
    ...plan,
    status: "manual",
    reason: "a plist Ocean did not write has this name",
  };
}

type Options = { env?: ClientEnv; platform?: NodeJS.Platform };

// macOS only for now: launchd's WatchPaths is what makes an app install wake the detector.
export async function planClientDetect(
  options: Options = {},
): Promise<ClientDetectPlan[]> {
  const env = options.env ?? defaultClientEnv();
  if ((options.platform ?? process.platform) !== "darwin") return [];
  const text = await readIfPresent(path.join(env.home, CLIENT_DETECT_FILE));
  return [planText(text, clientDetectPlist(env))];
}

// bridge/state/clients/detected.json: every client the detector has seen installed, and when.
type Detected = { seen: Record<string, string> };

export function detectedFile(): string {
  return oceanPath(SYSTEM_DIR, "state", "clients", "detected.json");
}

async function readDetected(): Promise<Detected | null> {
  const text = await readIfPresent(detectedFile());
  if (text === null) return null;
  const parsed = JSON.parse(text) as Partial<Detected>;
  return { seen: parsed.seen ?? {} };
}

async function writeDetected(detected: Detected): Promise<void> {
  const file = detectedFile();
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, `${JSON.stringify(detected, null, 2)}\n`, 0o600);
}

export type NewClient = { client: string; label: string; command: string };

// Installed clients not seen before; only those Ocean can wire now (`change`) are offered, the
// rest are recorded so they are never offered later. With no record yet, everything installed is
// recorded and nothing is offered.
export async function detectNewClients(
  options: { plans?: ClientPlan[]; now?: Date } = {},
): Promise<{ seeded: boolean; offers: NewClient[] }> {
  const plans = options.plans ?? (await planClients());
  const at = (options.now ?? new Date()).toISOString();
  const before = await readDetected();
  const seen = { ...(before?.seen ?? {}) };
  const offers: NewClient[] = [];
  for (const plan of plans) {
    if (!plan.installed || seen[plan.client]) continue;
    seen[plan.client] = at;
    if (before && plan.status === "change")
      offers.push({
        client: plan.client,
        label: plan.label,
        command: `ocean clients apply --client ${plan.client} --yes`,
      });
  }
  if (!before || Object.keys(seen).length !== Object.keys(before.seen).length)
    await writeDetected({ seen });
  return { seeded: !before, offers };
}

type Run = (command: string, args: string[]) => Promise<unknown>;
const runCommand: Run = (command, args) => promisify(execFile)(command, args);
const domain = () => `gui/${process.getuid?.() ?? ""}`;

// AppleScript string literal: backslash and double quote escaped; labels come from the registry.
const appleString = (text: string) =>
  `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

// One notification per new client. Best effort: a refused notification never fails the run.
export async function notifyNewClients(
  offers: NewClient[],
  run: Run = runCommand,
): Promise<void> {
  for (const offer of offers)
    await run("osascript", [
      "-e",
      `display notification ${appleString(`Connect it to Ocean: ${offer.command}`)} with title "Ocean" subtitle ${appleString(`${offer.label} is installed`)}`,
    ]).catch(() => {});
}

// Writes the plist, records every installed client as seen, and (re)loads the job. Loading is
// best effort: the plist stays, and the next login loads it.
export async function applyClientDetect(
  options: Options & {
    clients?: string[];
    batch?: string;
    durable?: boolean;
    run?: Run;
    plans?: ClientPlan[];
  } = {},
): Promise<{ batch: string; results: { client: string; result: string }[] }> {
  const env = options.env ?? defaultClientEnv();
  const batch = options.batch ?? newBatch();
  if (options.clients?.length) return { batch, results: [] };
  const [plan] = await planClientDetect({ ...options, env });
  if (plan?.status !== "change") return { batch, results: [] };
  if (options.durable ?? !options.env) {
    const problem = temporaryEntryProblem(env.entry);
    if (problem)
      throw new Error(`Refusing to add the client detector: ${problem}`);
  }
  const want = clientDetectPlist(env);
  const file = path.join(env.home, CLIENT_DETECT_FILE);
  const result = await edit(
    file,
    (text) => {
      const current = text === "" ? null : text;
      if (planText(current, want).status !== "change") return null;
      return {
        next: want,
        entries: [
          {
            client: OWNER,
            file: CLIENT_DETECT_FILE,
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
  if (result !== "written")
    return { batch, results: [{ client: OWNER, result }] };
  await detectNewClients({ plans: options.plans ?? (await planClients(env)) });
  const run = options.run ?? runCommand;
  await run("launchctl", [
    "bootout",
    `${domain()}/${CLIENT_DETECT_LABEL}`,
  ]).catch(() => {});
  const loaded = await run("launchctl", ["bootstrap", domain(), file]).then(
    () => true,
    () => false,
  );
  return {
    batch,
    results: [
      {
        client: OWNER,
        result: loaded ? "written" : "written (loads at next login)",
      },
    ],
  };
}

// Unloads and removes the plist one apply batch wrote, unless it changed since (a conflict).
export async function restoreClientDetect(options: {
  batch: string;
  env?: ClientEnv;
  run?: Run;
}): Promise<{ restored: string[]; conflicts: string[] }> {
  const env = options.env ?? defaultClientEnv();
  const entries = (await readJournal()).filter(
    (entry) =>
      entry.batch === options.batch &&
      entry.client === OWNER &&
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
      conflicts.push(`${OWNER}:${KEY}`);
      continue;
    }
    await (options.run ?? runCommand)("launchctl", [
      "bootout",
      `${domain()}/${CLIENT_DETECT_LABEL}`,
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
    restored.push(`${OWNER}:${KEY}`);
  }
  return { restored, conflicts };
}

// Doctor view: the detector is off or stale, a plist Ocean did not write holds its name, or it
// is loaded with the date it last recorded a client.
export async function clientDetectFindings(
  options: Options = {},
): Promise<ClientFinding[]> {
  const [plan] = await planClientDetect(options);
  if (!plan) return [];
  if (plan.status === "change")
    return [
      {
        code: "CLIENT_DETECT_MISSING",
        severity: "WARN",
        message:
          "New AI clients are not offered to Ocean: the client detector is missing or out of date — run `ocean clients apply --yes`",
        fixable: true,
      },
    ];
  if (plan.status === "manual")
    return [
      {
        code: "CLIENT_DETECT_MANUAL",
        severity: "WARN",
        message: `Client detector: ${plan.reason} (${plan.file})`,
        fixable: false,
      },
    ];
  const detected = existsSync(detectedFile()) ? await readDetected() : null;
  const last = Object.values(detected?.seen ?? {})
    .sort()
    .at(-1);
  return [
    {
      code: "CLIENT_DETECT_OK",
      severity: "OK",
      message: last
        ? `Client detector loaded; last new client recorded ${last}`
        : "Client detector loaded; no client recorded yet",
      fixable: false,
    },
  ];
}
