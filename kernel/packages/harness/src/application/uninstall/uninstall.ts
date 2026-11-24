import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { atomicWrite } from "@ocean/core/shared/fs-utils.js";
import { liveEngineEntry, oceanRoot } from "@ocean/core/shared/paths.js";
import { removeCoreSkills } from "@ocean/market/skills/core-skill-sync.js";
import {
  backupPath,
  type ClientEnv,
  defaultClientEnv,
  type JournalEntry,
  newBatch,
  readJournal,
  removeBackups,
  removeOceanEntries,
  restoreClients,
} from "../clients/clients.js";
import {
  DESKTOP_WATCHER_FILE,
  DESKTOP_WATCHER_LABEL,
  restoreDesktopWatcher,
} from "../clients/desktop-watcher.js";
import { removeOceanHooks, restoreHooks } from "../clients/hooks.js";
import { restoreNative } from "../clients/native.js";
import { restoreOpencodePlugin } from "../clients/opencode-plugin.js";
import { removeCharterCopies } from "../integrations/charter-copies.js";
import { removeClaudeCodeWrapper } from "../integrations/claude-vscode.js";
import { syncSkillFilter } from "../integrations/skill-filter.js";

// `ocean uninstall`: puts the machine back the way it was before `ocean setup` and
// `ocean clients apply`, outside the workspace — client configs, hooks, native-memory switches,
// launch services, the shell profile block and the shims. The workspace itself (memory, tasks,
// sessions) stays unless `--purge` asks for it, so running `ocean setup` again reconnects it.
// Every step only removes what Ocean wrote; anything the owner changed since is left and named.

type Run = (command: string, args: string[]) => Promise<unknown>;
const runCommand: Run = (command, args) => promisify(execFile)(command, args);

export type UninstallOptions = {
  env?: ClientEnv;
  platform?: NodeJS.Platform;
  run?: Run;
  root?: string;
  // Wired by the CLI (application code does not reach infrastructure): the shim folder and the
  // function that strips Ocean's block from a shell profile.
  shimDir: string;
  stripProfile: (text: string) => string;
  vscodeSettings?: string;
  purge?: boolean;
};

export type UninstallItem = { area: string; target: string };

export type UninstallReport = {
  removed: UninstallItem[];
  left: UninstallItem[];
  purged: string | null;
  next: string[];
};

// Shell files a profile block may be in: the shell can have changed since setup ran.
const SHELL_PROFILES = [
  ".zshrc",
  ".zprofile",
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".config/fish/config.fish",
  "Documents/PowerShell/Microsoft.PowerShell_profile.ps1",
];
const PROFILE_MARKER = "# >>> ocean interception >>>";

const RUNTIME_LABEL = "com.ocean.runtime";
const BRIDGE_LABEL = "com.ocean.browser-bridge";

function context(options: UninstallOptions) {
  const env = options.env ?? defaultClientEnv();
  const home = env.home;
  const platform = options.platform ?? process.platform;
  return {
    env,
    home,
    platform,
    run: options.run ?? runCommand,
    root: options.root ?? oceanRoot(),
    shimDir: options.shimDir,
    domain: `gui/${process.getuid?.() ?? ""}`,
    launchAgent: (label: string) =>
      path.join(home, "Library", "LaunchAgents", `${label}.plist`),
    systemdUnit: path.join(home, ".config", "systemd", "user", "ocean.service"),
    windowsStartup: path.join(
      process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
      "ocean.cmd",
    ),
  };
}

type Context = ReturnType<typeof context>;

// Apply batches not yet fully undone, newest first. An entry counts as undone once a restore
// note names its batch, client, file, op and key.
export function pendingBatches(journal: JournalEntry[]): string[] {
  const id = (entry: JournalEntry, batch: string) =>
    [batch, entry.client, entry.file, entry.op, entry.key].join("\u0000");
  const undone = new Set(
    journal
      .filter((entry) => entry.restoreOf)
      .map((entry) => id(entry, entry.restoreOf as string)),
  );
  const order: string[] = [];
  const open = new Set<string>();
  for (const entry of journal) {
    if (entry.restoreOf) continue;
    if (!order.includes(entry.batch)) order.push(entry.batch);
    if (!undone.has(id(entry, entry.batch))) open.add(entry.batch);
  }
  return order.filter((batch) => open.has(batch)).reverse();
}

async function profileFiles(home: string): Promise<string[]> {
  const found: string[] = [];
  for (const relative of SHELL_PROFILES) {
    const file = path.join(home, relative);
    const text = await readFile(file, "utf8").catch(() => null);
    if (text?.includes(PROFILE_MARKER)) found.push(file);
  }
  return found;
}

function serviceFiles(ctx: Context): UninstallItem[] {
  const files =
    ctx.platform === "darwin"
      ? [
          ctx.launchAgent(RUNTIME_LABEL),
          ctx.launchAgent(BRIDGE_LABEL),
          path.join(ctx.home, DESKTOP_WATCHER_FILE),
        ]
      : ctx.platform === "linux"
        ? [ctx.systemdUnit]
        : ctx.platform === "win32"
          ? [ctx.windowsStartup]
          : [];
  return files
    .filter((file) => existsSync(file))
    .map((target) => ({ area: "service", target }));
}

// Why the workspace must not be deleted by a command, or null when it may be.
export function purgeRefusal(root: string, home: string): string | null {
  const resolved = path.resolve(root);
  if (resolved === path.resolve(home) || resolved === path.parse(resolved).root)
    return `${resolved} is not a workspace folder`;
  if (existsSync(path.join(resolved, ".git")))
    return `${resolved} is a git checkout; delete it by hand if you mean to`;
  const engine = path.relative(resolved, liveEngineEntry());
  if (!engine.startsWith("..") && !path.isAbsolute(engine))
    return `the running Ocean engine is inside ${resolved}; delete it by hand if you mean to`;
  return null;
}

// What `ocean uninstall` would change, read-only.
export async function planUninstall(
  options: UninstallOptions,
): Promise<{ items: UninstallItem[]; purge: string | null; refusal?: string }> {
  const ctx = context(options);
  const items: UninstallItem[] = [];
  const batches = pendingBatches(await readJournal());
  if (batches.length)
    items.push({
      area: "clients",
      target: `undo ${batches.length} \`ocean clients apply\` change set(s), then remove any Ocean MCP entry and hook still there`,
    });
  else
    items.push({
      area: "clients",
      target: "remove any Ocean MCP entry and hook still in a client config",
    });
  const backups = new Set(
    (await readJournal())
      .filter((entry) => !entry.restoreOf)
      .map((entry) => backupPath(path.join(ctx.home, entry.file), entry.batch))
      .filter((file) => existsSync(file)),
  );
  if (backups.size)
    items.push({
      area: "backups",
      target: `${backups.size} config backup(s) Ocean wrote before editing (kept where a change cannot be undone cleanly)`,
    });
  items.push({
    area: "skills",
    target:
      "Ocean's core skill copies, the charter copy in Codex and Gemini rules, the skills Ocean disabled",
  });
  items.push(...serviceFiles(ctx));
  for (const file of await profileFiles(ctx.home))
    items.push({
      area: "shell",
      target: `${file} (the ocean interception block)`,
    });
  if (existsSync(ctx.shimDir))
    items.push({ area: "shims", target: ctx.shimDir });
  if (!options.purge) return { items, purge: null };
  const refusal = purgeRefusal(ctx.root, ctx.home);
  return refusal ? { items, purge: null, refusal } : { items, purge: ctx.root };
}

async function stopServices(
  ctx: Context,
  report: UninstallReport,
): Promise<void> {
  if (ctx.platform === "darwin") {
    for (const label of [DESKTOP_WATCHER_LABEL, BRIDGE_LABEL, RUNTIME_LABEL]) {
      const file = ctx.launchAgent(label);
      if (!existsSync(file)) continue;
      await ctx
        .run("launchctl", ["bootout", `${ctx.domain}/${label}`])
        .catch(() => {});
      await rm(file, { force: true });
      report.removed.push({ area: "service", target: file });
    }
  } else if (ctx.platform === "linux" && existsSync(ctx.systemdUnit)) {
    await ctx
      .run("systemctl", ["--user", "disable", "--now", "ocean.service"])
      .catch(() => {});
    await rm(ctx.systemdUnit, { force: true });
    await ctx.run("systemctl", ["--user", "daemon-reload"]).catch(() => {});
    report.removed.push({ area: "service", target: ctx.systemdUnit });
  } else if (ctx.platform === "win32" && existsSync(ctx.windowsStartup)) {
    await rm(ctx.windowsStartup, { force: true });
    report.removed.push({ area: "service", target: ctx.windowsStartup });
    report.next.push(
      "the Ocean runtime started at this login keeps running until you sign out",
    );
  }
}

export async function runUninstall(
  options: UninstallOptions,
): Promise<UninstallReport> {
  const ctx = context(options);
  const report: UninstallReport = {
    removed: [],
    left: [],
    purged: null,
    next: [],
  };
  const removed = (area: string, targets: string[]) =>
    report.removed.push(...targets.map((target) => ({ area, target })));
  const left = (area: string, targets: string[]) =>
    report.left.push(...targets.map((target) => ({ area, target })));

  // 1. Launch services first — the runtime, the Desktop watcher, the retired browser bridge — so
  // nothing re-wires a client while its config is being put back.
  await stopServices(ctx, report);

  // 2. Client configs: every journaled apply undone, newest first, then whatever Ocean wrote
  // that the journal does not cover (or that a conflict kept).
  const conflicts = new Set<string>();
  for (const batch of pendingBatches(await readJournal())) {
    const env = ctx.env;
    const results = [
      await restoreClients({ batch, env }),
      await restoreHooks({ batch, env }),
      await restoreOpencodePlugin({ batch, env }),
      await restoreNative({ batch, env }),
      await restoreDesktopWatcher({ batch, env, run: ctx.run }),
    ];
    for (const result of results) {
      removed("clients", result.restored);
      for (const conflict of result.conflicts) conflicts.add(conflict);
    }
  }
  const sweep = newBatch();
  const entries = await removeOceanEntries({ env: ctx.env, batch: sweep });
  const hooks = await removeOceanHooks({ env: ctx.env });
  removed("clients", [...entries.removed, ...hooks.removed]);
  left("clients", [...entries.left, ...hooks.left]);
  // MCP entries, hooks and the Desktop watcher are swept regardless of the journal, so their
  // conflicts are settled; a native switch or plugin the owner changed since is named instead.
  for (const conflict of conflicts)
    if (conflict.endsWith(":native") || conflict.endsWith(":plugin"))
      left("clients", [
        `${conflict} (changed since Ocean wrote it; check by hand)`,
      ]);
  // The config backups apply wrote (T-328 P5) go too, except where a conflict above means the
  // copy is still the owner's way back.
  const backups = await removeBackups(
    ctx.home,
    await readJournal(),
    new Set([...conflicts].map((conflict) => conflict.split(":")[0])),
  );
  removed("backups", backups.removed);
  left(
    "backups",
    backups.kept.map((file) => `${file} (your config before Ocean edited it)`),
  );

  // 3. Skills and rules Ocean copied into clients.
  const skills = await removeCoreSkills(ctx.home);
  removed("skills", skills.removed);
  left(
    "skills",
    skills.kept.map((item) => `${item} (edited since Ocean copied it)`),
  );
  removed("rules", await removeCharterCopies(ctx.home));
  const filter = await syncSkillFilter(ctx.home, new Set());
  removed(
    "skills",
    filter
      .filter((result) => result.status === "updated")
      .map((result) => `${result.file} (skills Ocean disabled)`),
  );
  const vscode = await removeClaudeCodeWrapper(
    ctx.shimDir,
    options.vscodeSettings,
  );
  if (vscode)
    removed("clients", [`${vscode} (claudeCode.claudeProcessWrapper)`]);

  // 4. Shell profile blocks and the shims they put on PATH.
  for (const file of await profileFiles(ctx.home)) {
    const text = await readFile(file, "utf8");
    const next = options.stripProfile(text);
    if (next === text) continue;
    await atomicWrite(file, next);
    removed("shell", [file]);
  }
  if (existsSync(ctx.shimDir)) {
    await rm(ctx.shimDir, { recursive: true, force: true });
    removed("shims", [ctx.shimDir]);
  }

  // 5. The workspace, only on --purge, and never one that is a checkout or holds the engine.
  if (options.purge) {
    const refusal = purgeRefusal(ctx.root, ctx.home);
    if (refusal) left("workspace", [refusal]);
    else {
      await rm(ctx.root, { recursive: true, force: true });
      report.purged = ctx.root;
    }
  }

  report.next.push(
    "open a new terminal (the current one still has the old PATH)",
    "npm uninstall --global @amoree-code/ocean",
  );
  if (!report.purged && !options.purge)
    report.next.push(
      `your workspace is kept at ${ctx.root}; delete it by hand, or run \`ocean uninstall --yes --purge\``,
    );
  return report;
}
