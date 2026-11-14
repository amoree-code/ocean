import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clientJournalFile } from "@ocean/brain/memory/memory-paths.js";
import { containsKnownSecret } from "@ocean/core/domain/redaction/redaction.js";
import { atomicWrite, withFileLock } from "@ocean/core/shared/fs-utils.js";
import {
  liveEngineEntry,
  oceanPath,
  SYSTEM_DIR,
} from "@ocean/core/shared/paths.js";
import { marketplacePaths } from "@ocean/market/install/default-marketplace.js";
import {
  ENTRY_KEYS,
  ManualEdit,
  type Op,
  type ServerValue,
} from "./editors.js";
import {
  CLIENT_ADAPTERS,
  type ClientAdapter,
  type ClientTier,
  mcpClientOf,
  type NativeMemoryPolicy,
} from "./registry.js";

// Detect, plan, apply, restore and verify the `ocean` MCP entry in every installed client
// (T-296 P2). Only Ocean-managed entries are touched: `ocean` (the brain server), a legacy
// `ocean` that runs the Obsidian server (moved to `ocean-obsidian`), dead entries of the
// retired atlas gateway, and one `ocean market exec` entry per installed marketplace MCP server
// (T-298). Rollback uses a journal of those entries' values — never a copy of a
// client's file, which can hold credentials next to its servers.

export type ClientEnv = {
  home: string;
  pathDirs: string[];
  appDirs: string[];
  entry: ServerValue;
  // Entries for installed marketplace MCP servers, by client key.
  market?: Map<string, ServerValue>;
  // Clients (by id) wired to one `ocean-gateway` entry instead of an entry per marketplace
  // server (T-309), and that entry.
  gateway?: { clients: Set<string>; entry: ServerValue };
};

// Keys Ocean already manages for its own servers; a marketplace server never takes one.
const RESERVED_KEYS = new Set(["ocean", "ocean-obsidian", "ocean-gateway"]);

// What a gateway-wired client runs: every installed server through one process, without
// Ocean's own servers, which stay direct entries so their tool names do not change.
export const GATEWAY_COMMAND = ["mcp", "gateway", "--installed-only"];

function gatewayClientsFile(): string {
  return oceanPath(SYSTEM_DIR, "state", "clients", "gateway.json");
}

// `bridge/state/clients/gateway.json`: whether clients reach installed servers through the
// gateway by default, and the clients that differ from that default. Missing means per-server
// (a machine set up before T-309); a fresh onboarding writes `default: gateway`.
type GatewayChoice = {
  default: "gateway" | "per-server";
  gateway: string[];
  perServer: string[];
};

function readGatewayChoice(file: string): GatewayChoice {
  const choice: GatewayChoice = {
    default: "per-server",
    gateway: [],
    perServer: [],
  };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return choice;
  }
  const ids = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string")
      : [];
  if (raw.default === "gateway") choice.default = "gateway";
  // `clients` is the T-309 phase-4 name of `gateway`.
  choice.gateway = [...new Set([...ids(raw.gateway), ...ids(raw.clients)])];
  choice.perServer = ids(raw.perServer);
  return choice;
}

async function writeGatewayChoice(
  file: string,
  choice: GatewayChoice,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(
    file,
    `${JSON.stringify(
      {
        default: choice.default,
        gateway: [...new Set(choice.gateway)].sort(),
        perServer: [...new Set(choice.perServer)].sort(),
      },
      null,
      2,
    )}\n`,
  );
}

const clientIds = () => CLIENT_ADAPTERS.map((adapter) => adapter.id);

export function readGatewayClients(
  file = gatewayClientsFile(),
  ids: string[] = clientIds(),
): Set<string> {
  const choice = readGatewayChoice(file);
  return new Set(
    choice.default === "gateway"
      ? ids.filter((id) => !choice.perServer.includes(id))
      : choice.gateway.filter((id) => ids.includes(id)),
  );
}

export function gatewayDefault(
  file = gatewayClientsFile(),
): GatewayChoice["default"] {
  return readGatewayChoice(file).default;
}

// `ocean clients gateway <client> on|off`: recorded here, applied by `ocean clients apply`.
export async function setGatewayClient(
  client: string,
  on: boolean,
  file = gatewayClientsFile(),
): Promise<string[]> {
  if (!clientIds().includes(client))
    throw new Error(
      `Unknown client ${client}; one of: ${clientIds().join(", ")}`,
    );
  const choice = readGatewayChoice(file);
  choice.gateway = choice.gateway.filter((id) => id !== client);
  choice.perServer = choice.perServer.filter((id) => id !== client);
  if (on && choice.default !== "gateway") choice.gateway.push(client);
  if (!on && choice.default === "gateway") choice.perServer.push(client);
  await writeGatewayChoice(file, choice);
  return [...readGatewayClients(file)].sort();
}

// `ocean clients gateway --default gateway|per-server`; the per-client choices are kept.
export async function setGatewayDefault(
  mode: GatewayChoice["default"],
  file = gatewayClientsFile(),
): Promise<string[]> {
  const choice = readGatewayChoice(file);
  choice.default = mode;
  await writeGatewayChoice(file, choice);
  return [...readGatewayClients(file)].sort();
}

// A fresh machine (no choice recorded, no client approved yet) starts with the gateway as the
// default. A machine already wired per server keeps that until its owner switches.
export async function defaultToGatewayOnFreshSetup(
  file = gatewayClientsFile(),
): Promise<boolean> {
  if (existsSync(file)) return false;
  if (Object.keys(await approvedClients()).length) return false;
  await writeGatewayChoice(file, {
    default: "gateway",
    gateway: [],
    perServer: [],
  });
  return true;
}

// The marketplace entries one client should have: the single gateway entry when it is wired to
// the gateway, otherwise one entry per installed server.
function marketFor(
  client: string,
  env: ClientEnv,
): Map<string, ServerValue> | undefined {
  if (env.gateway?.clients.has(client)) {
    const entry = env.gateway.entry;
    // The client's id travels in its own entry, so the gateway's access rules match the name
    // Ocean wrote rather than the name the client gives itself.
    return new Map([
      [
        "ocean-gateway",
        {
          ...entry,
          args: [
            ...(Array.isArray(entry.args) ? entry.args : []),
            "--client",
            client,
          ],
        },
      ],
    ]);
  }
  return env.market;
}

export type ClientStatus =
  | "current"
  | "change"
  | "manual"
  | "not-installed"
  | "context-file"
  | "unsupported"
  | "unknown";

export type ClientPlan = {
  client: string;
  label: string;
  tier: ClientTier;
  installed: boolean;
  evidence: string[];
  file?: string;
  status: ClientStatus;
  ops: Op[];
  nativeMemory: NativeMemoryPolicy;
  reason?: string;
  fallback?: string;
  snippet?: string;
};

// `hook-add` entries belong to hooks.ts (a session-start hook group) and `native-set` to native.ts
// (a native-memory setting); restoreClients skips both.
export type JournalEntry = {
  batch: string;
  ts: string;
  client: string;
  file: string;
  op: Op["kind"] | "hook-add" | "native-set";
  key: string;
  to?: string;
  before: ServerValue | null;
  beforeSha?: string;
  after: ServerValue | null;
  // hook-add: the object keys the add created, removed again on restore once empty.
  created?: string[];
  restoreOf?: string;
};

// A node inside a version manager's tree disappears when that version is removed (T-307).
const VERSIONED_NODE =
  /[\\/](?:node-versions|\.nvm[\\/]versions[\\/]node|\.volta[\\/]tools[\\/]image[\\/]node|\.asdf[\\/]installs[\\/]nodejs|mise[\\/]installs[\\/]node|n[\\/]versions[\\/]node)[\\/]/;

export function isVersionedNode(execPath: string): boolean {
  return VERSIONED_NODE.test(execPath);
}

// The `ocean` MCP entry. With a version-managed node it launches through the `ocean` shim, which
// falls back to another node when that version is gone; a temporary engine keeps the direct form
// so `temporaryEntryProblem` still refuses it.
export function oceanServerEntry(
  execPath = process.execPath,
  engine = liveEngineEntry(),
  platform: NodeJS.Platform = process.platform,
  command: string[] = ["mcp", "serve"],
): ServerValue {
  const direct = { command: execPath, args: [engine, ...command] };
  if (
    platform === "win32" ||
    !isVersionedNode(execPath) ||
    temporaryEntryProblem(direct)
  )
    return direct;
  return {
    command: oceanPath(SYSTEM_DIR, "runtime", "shims", "ocean"),
    args: command,
  };
}

// One client entry per MCP server installed from the marketplace, keyed by its declared
// `clientKey` and started through `ocean market exec`, so every client launches it the same
// checked way. Remote-only servers are left out: a client connects to those by url.
export function marketServerEntries(
  serversRoot: string,
  entryFor: (command: string[]) => ServerValue = (command) =>
    oceanServerEntry(undefined, undefined, undefined, command),
): Map<string, ServerValue> {
  const entries = new Map<string, ServerValue>();
  let files: string[] = [];
  try {
    files = readdirSync(serversRoot)
      .filter((file) => file.endsWith(".json"))
      .sort();
  } catch {
    return entries;
  }
  for (const file of files) {
    let installed: {
      capability?: unknown;
      server?: { packages?: unknown[]; _meta?: Record<string, unknown> };
    };
    try {
      installed = JSON.parse(
        readFileSync(path.join(serversRoot, file), "utf8"),
      );
    } catch {
      continue;
    }
    const name = installed.capability;
    if (typeof name !== "string" || !installed.server?.packages?.length)
      continue;
    const meta = installed.server._meta?.["dev.ocean"] as
      | { clientKey?: unknown }
      | undefined;
    const key =
      typeof meta?.clientKey === "string"
        ? meta.clientKey
        : (name.split("/").at(-1) ?? name);
    if (RESERVED_KEYS.has(key) || entries.has(key)) continue;
    entries.set(key, entryFor(["market", "exec", name]));
  }
  return entries;
}

export function defaultClientEnv(): ClientEnv {
  const home = os.homedir();
  return {
    home,
    pathDirs: (process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    appDirs:
      process.platform === "darwin"
        ? ["/Applications", path.join(home, "Applications")]
        : [],
    entry: oceanServerEntry(),
    market: marketServerEntries(marketplacePaths().mcpServers),
    gateway: {
      clients: readGatewayClients(),
      entry: oceanServerEntry(undefined, undefined, undefined, GATEWAY_COMMAND),
    },
  };
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function detect(adapter: ClientAdapter, env: ClientEnv): string[] {
  const evidence: string[] = [];
  for (const name of adapter.detect.binaries ?? [])
    for (const dir of env.pathDirs)
      if (executable(path.join(dir, name))) {
        evidence.push(`binary ${name}`);
        break;
      }
  for (const app of adapter.detect.apps ?? [])
    if (env.appDirs.some((dir) => existsSync(path.join(dir, app))))
      evidence.push(`app ${app}`);
  for (const relative of adapter.detect.paths ?? [])
    if (existsSync(path.join(env.home, relative)))
      evidence.push(`~/${relative}`);
  return evidence;
}

// A TOML entry with sub-tables carries a `__subtables` marker, which fails the key check too.
const isOceanShaped = (value: ServerValue | undefined) =>
  Boolean(value) &&
  Object.keys(value ?? {}).every((key) => ENTRY_KEYS.includes(key));

const sameEntry = (value: ServerValue | undefined, entry: ServerValue) =>
  Boolean(value) &&
  value?.command === entry.command &&
  JSON.stringify(value?.args ?? []) === JSON.stringify(entry.args ?? []);

const runsObsidian = (value: ServerValue) =>
  Array.isArray(value.args) && value.args.includes("obsidian");

// The retired atlas gateway: an entry that names it and whose program no longer exists.
function staleAtlas(key: string, value: ServerValue): boolean {
  const command = typeof value.command === "string" ? value.command : "";
  return (
    (/atlas/i.test(key) || /atlas/i.test(command)) &&
    path.isAbsolute(command) &&
    !existsSync(command)
  );
}

// Windows' tmpdir can be an 8.3 short path (C:\\Users\\RUNNER~1\\...) while an engine's path is the
// long form of the same directory.
function realTemporaryDir(): string[] {
  try {
    return [realpathSync.native(os.tmpdir())];
  } catch {
    return [];
  }
}

// A build in a temporary directory (a scratch worktree) disappears with it, and every client
// wired to it would then fail to start Ocean.
const TEMPORARY_ROOTS = [
  os.tmpdir(),
  ...realTemporaryDir(),
  "/tmp",
  "/private/tmp",
  "/var/folders",
  "/private/var/folders",
];

// `paths` is a parameter so the Windows rules (separator, case, drives) are testable anywhere.
export function isWithinDir(
  dir: string,
  file: string,
  paths: path.PlatformPath = path,
): boolean {
  const relative = paths.relative(dir, file);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${paths.sep}`) &&
    !paths.isAbsolute(relative)
  );
}

export function temporaryEntryProblem(entry: ServerValue): string | null {
  const program = Array.isArray(entry.args) ? entry.args[0] : undefined;
  if (typeof program !== "string") return null;
  const resolved = path.resolve(program);
  const root = TEMPORARY_ROOTS.find((dir) => isWithinDir(dir, resolved));
  return root
    ? `the Ocean engine ${resolved} is in a temporary directory (${root}); run this from the workspace kernel checkout`
    : null;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// The ops that bring one config text to the desired state, or why it needs a hand edit.
function opsFor(
  adapter: ClientAdapter,
  text: string,
  entry: ServerValue,
  market?: Map<string, ServerValue>,
): { ops: Op[]; manual?: string } {
  const editor = adapter.config?.editor;
  const servers = editor?.servers(text);
  if (!editor || !servers)
    return {
      ops: [],
      manual: adapter.reason ?? "the server table cannot be read",
    };
  const ops: Op[] = [];
  const ocean = servers.get("ocean");
  const legacy = ocean ? runsObsidian(ocean) : false;
  if (ocean && legacy) {
    if (!isOceanShaped(ocean))
      return {
        ops: [],
        manual: "the legacy `ocean` entry has keys Ocean does not manage",
      };
    // With an `ocean-obsidian` already there, the legacy entry is simply replaced in place below.
    if (!servers.has("ocean-obsidian"))
      ops.push({ kind: "rename", key: "ocean", to: "ocean-obsidian" });
  }
  for (const [key, value] of servers)
    if (key !== "ocean" && staleAtlas(key, value) && isOceanShaped(value))
      ops.push({ kind: "remove", key });
  if (!ocean || legacy) ops.push({ kind: "set", key: "ocean", value: entry });
  else if (!isOceanShaped(ocean))
    return {
      ops: [],
      manual: "the `ocean` entry has keys Ocean does not manage",
    };
  else if (!sameEntry(ocean, entry))
    ops.push({ kind: "set", key: "ocean", value: entry });
  // Marketplace servers: added, kept current, and removed once uninstalled. A key holding the
  // owner's own server (not an `ocean market exec` entry) is left alone. Without a market list
  // (a caller's own env) they are not managed at all, never all removed.
  if (!market) return { ops };
  for (const [key, value] of servers)
    if (isMarketExec(value) && !market.has(key))
      ops.push({ kind: "remove", key });
  for (const [key, want] of market) {
    const have = servers.get(key);
    if (!have || (isMarketExec(have) && !sameEntry(have, want)))
      ops.push({ kind: "set", key, value: want });
  }
  return { ops };
}

// An Ocean-managed entry that starts installed marketplace servers: one `ocean market exec`, or
// the client's gateway entry. A gateway entry the owner added by hand (`ocean mcp
// gateway-config`, no `--installed-only`) is the owner's and is left alone.
function isMarketExec(value: ServerValue): boolean {
  if (!isOceanShaped(value) || !Array.isArray(value.args)) return false;
  const at = value.args.indexOf("market");
  if (at >= 0 && value.args[at + 1] === "exec") return true;
  const gateway = value.args.indexOf("gateway");
  return (
    gateway > 0 &&
    value.args[gateway - 1] === "mcp" &&
    value.args.includes("--installed-only")
  );
}

export async function planClients(
  env: ClientEnv = defaultClientEnv(),
): Promise<ClientPlan[]> {
  const plans: ClientPlan[] = [];
  for (const adapter of CLIENT_ADAPTERS) {
    const evidence = detect(adapter, env);
    const plan: ClientPlan = {
      client: adapter.id,
      label: adapter.label,
      tier: adapter.tier,
      installed: evidence.length > 0,
      evidence,
      file: adapter.config ? `~/${adapter.config.file}` : undefined,
      status: "current",
      ops: [],
      nativeMemory: adapter.nativeMemory,
      reason: adapter.reason,
      fallback: adapter.fallback,
    };
    if (!plan.installed) plan.status = "not-installed";
    else if (adapter.tier !== "supported" || !adapter.config)
      plan.status = adapter.tier === "supported" ? "unknown" : adapter.tier;
    else {
      const text =
        (await readText(path.join(env.home, adapter.config.file))) ?? "";
      const { ops, manual } = opsFor(
        adapter,
        text,
        env.entry,
        marketFor(adapter.id, env),
      );
      plan.ops = ops;
      plan.status = ops.length ? "change" : "current";
      if (!manual && ops.length)
        try {
          adapter.config.editor.apply(text, ops);
        } catch (error) {
          if (!(error instanceof ManualEdit)) throw error;
          plan.reason = error.message;
          plan.status = "manual";
        }
      if (manual) {
        plan.reason = manual;
        plan.status = "manual";
      }
      if (plan.status === "manual")
        plan.snippet = JSON.stringify({
          ocean: env.entry,
          ...Object.fromEntries(marketFor(adapter.id, env) ?? []),
        });
    }
    plans.push(plan);
  }
  return plans;
}

function stateFile(): string {
  return oceanPath(SYSTEM_DIR, "state", "clients", "clients.json");
}

// How far a client's use of Ocean is proven (T-307). Only `in-app` — the client's model searched
// Ocean during normal use and cited the record — counts as done; `blocked` names why that check
// cannot run yet. A confirmation recorded before labels existed has none and proves nothing.
export const EVIDENCE_LABELS = [
  "in-app",
  "headless",
  "connected",
  "blocked",
] as const;
export type EvidenceLabel = (typeof EVIDENCE_LABELS)[number];

export type ClientEvidence = {
  label: EvidenceLabel;
  // What proves it, e.g. the call-ledger timestamp of the search.
  via?: string;
  // Why the in-app check cannot run (`blocked`).
  reason?: string;
};

// bridge/state/clients/clients.json: which clients the owner approved, the last scripted
// verification of each, and the evidence recorded for its use of Ocean (§3.7 record).
export type ClientState = {
  approved: Record<string, { approvedAt: string }>;
  verified: Record<string, { verifiedAt: string; ok: boolean }>;
  confirmed: Record<string, { confirmedAt: string } & Partial<ClientEvidence>>;
};

export async function readClientState(): Promise<ClientState> {
  const text = await readText(stateFile());
  const parsed = text ? JSON.parse(text) : {};
  return {
    approved: parsed.approved ?? {},
    verified: parsed.verified ?? {},
    confirmed: parsed.confirmed ?? {},
  };
}

async function approvedClients(): Promise<ClientState["approved"]> {
  return (await readClientState()).approved;
}

async function updateClientState(
  change: (state: ClientState) => void,
): Promise<void> {
  const file = stateFile();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await withFileLock(file, async () => {
    const state = await readClientState();
    change(state);
    await atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  });
}

async function approve(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await updateClientState((state) => {
    for (const id of ids)
      state.approved[id] = { approvedAt: new Date().toISOString() };
  });
}

export async function recordVerification(
  client: string,
  ok: boolean,
): Promise<void> {
  await updateClientState((state) => {
    state.verified[client] = { verifiedAt: new Date().toISOString(), ok };
  });
}

const EVIDENCE_TEXT_MAX = 200;

function evidenceText(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, EVIDENCE_TEXT_MAX) : undefined;
}

// The call ledger keeps the raw MCP client name. Each row also names the Ocean client it
// belongs to and, where that client's modes send different names, the mode (T-307).
export function attributeLedger<T extends { client: string }>(
  rows: T[],
): (T & { oceanClient?: string; mode?: string })[] {
  return rows.map((row) => {
    const known = mcpClientOf(row.client);
    if (!known) return row;
    return {
      ...row,
      oceanClient: known.id,
      ...(known.mode ? { mode: known.mode } : {}),
    };
  });
}

// Records what was proven about a client's use of Ocean, and how.
export async function confirmClient(
  client: string,
  evidence: ClientEvidence,
): Promise<void> {
  if (!CLIENT_ADAPTERS.some((adapter) => adapter.id === client))
    throw new Error(`unknown client '${client}'`);
  if (!EVIDENCE_LABELS.includes(evidence.label))
    throw new Error(
      `unknown evidence label '${evidence.label}' (use ${EVIDENCE_LABELS.join(", ")})`,
    );
  const via = evidenceText(evidence.via);
  const reason = evidenceText(evidence.reason);
  if (evidence.label === "in-app" && !via)
    throw new Error("an in-app confirmation needs --via <evidence>");
  if (evidence.label === "blocked" && !reason)
    throw new Error("a blocked client needs --reason <why>");
  await updateClientState((state) => {
    state.confirmed[client] = {
      confirmedAt: new Date().toISOString(),
      label: evidence.label,
      ...(via ? { via } : {}),
      ...(reason ? { reason } : {}),
    };
  });
}

export async function appendJournal(entries: JournalEntry[]): Promise<void> {
  if (!entries.length) return;
  const file = clientJournalFile();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await withFileLock(file, () =>
    appendFile(
      file,
      entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
      { mode: 0o600 },
    ),
  );
}

export async function readJournal(): Promise<JournalEntry[]> {
  const text = await readText(clientJournalFile());
  return (text ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JournalEntry);
}

// A value goes into the journal only when it is Ocean-shaped and holds no secret; otherwise
// only its hash, and restoring it can only remove Ocean's entry.
function journalValue(value: ServerValue | undefined): {
  before: ServerValue | null;
  beforeSha?: string;
} {
  if (!value) return { before: null };
  const text = JSON.stringify(value);
  if (isOceanShaped(value) && !containsKnownSecret(text))
    return { before: value };
  return { before: null, beforeSha: sha(text) };
}

function simulate(state: Map<string, ServerValue>, op: Op): void {
  if (op.kind === "set") state.set(op.key, op.value);
  else if (op.kind === "remove") state.delete(op.key);
  else {
    const value = state.get(op.key);
    state.delete(op.key);
    if (value) state.set(op.to, value);
  }
}

export const newBatch = () =>
  `${new Date()
    .toISOString()
    .replace(/[-:TZ]/g, "")
    .slice(0, 14)}-${randomBytes(4).toString("hex")}`;

// Writes one client file: re-reads it right before the rename and recomputes when it changed
// meanwhile, so an edit the user (or the client) made in between is never overwritten.
// Exported for its test only.
export async function edit(
  file: string,
  change: (
    text: string,
  ) => { next: string; entries: Omit<JournalEntry, "batch" | "ts">[] } | null,
  batch: string,
): Promise<"written" | "unchanged"> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const text = await readText(file);
    const result = change(text ?? "");
    if (!result) return "unchanged";
    await mkdir(path.dirname(file), { recursive: true });
    const outcome = await withFileLock(file, async () => {
      if ((await readText(file)) !== text) return "retry" as const;
      await atomicWrite(file, result.next, text === null ? 0o600 : undefined);
      return "written" as const;
    });
    if (outcome === "retry") continue;
    const ts = new Date().toISOString();
    await appendJournal(
      result.entries.map((entry) => ({ ...entry, batch, ts })),
    );
    return "written";
  }
  throw new Error(
    `${file} kept changing while Ocean tried to edit it; try again`,
  );
}

// `durable` (default: on for this machine's real env) refuses an engine in a temporary directory.
export async function applyClients(
  options: {
    clients?: string[];
    env?: ClientEnv;
    durable?: boolean;
    batch?: string;
  } = {},
): Promise<{ batch: string; results: { client: string; result: string }[] }> {
  const env = options.env ?? defaultClientEnv();
  if (options.durable ?? !options.env) {
    const problem = temporaryEntryProblem(env.entry);
    if (problem) throw new Error(`Refusing to wire clients: ${problem}`);
  }
  const batch = options.batch ?? newBatch();
  const results: { client: string; result: string }[] = [];
  for (const plan of await planClients(env)) {
    if (options.clients && !options.clients.includes(plan.client)) continue;
    if (plan.status !== "change") {
      if (options.clients)
        results.push({ client: plan.client, result: plan.status });
      continue;
    }
    const adapter = CLIENT_ADAPTERS.find((item) => item.id === plan.client);
    if (!adapter?.config) continue;
    const config = adapter.config;
    const file = path.join(env.home, config.file);
    const result = await edit(
      file,
      (text) => {
        const { ops, manual } = opsFor(
          adapter,
          text,
          env.entry,
          marketFor(adapter.id, env),
        );
        if (manual || !ops.length) return null;
        // Each op's "before" is the table as the earlier ops of this batch left it.
        const state = new Map(config.editor.servers(text) ?? []);
        const entries = ops.map((op) => {
          const entry = {
            client: adapter.id,
            file: config.file,
            op: op.kind,
            key: op.key,
            to: op.kind === "rename" ? op.to : undefined,
            ...(op.kind === "rename"
              ? { before: null }
              : journalValue(state.get(op.key))),
            after: op.kind === "set" ? op.value : null,
          };
          simulate(state, op);
          return entry;
        });
        return { next: config.editor.apply(text, ops), entries };
      },
      batch,
    );
    results.push({ client: plan.client, result });
  }
  await approve(
    results
      .filter((item) => item.result === "written")
      .map((item) => item.client),
  );
  return { batch, results };
}

// Re-applies the desired entry for clients the owner already approved; never a new client.
export async function repairClients(env?: ClientEnv) {
  const approved = Object.keys(await approvedClients());
  if (!approved.length) return { batch: null, results: [] };
  return applyClients({ clients: approved, env });
}

// Undoes one apply batch (default: the latest), entry by entry in reverse. An entry whose
// node no longer holds what Ocean wrote is a conflict and is left alone.
export async function restoreClients(
  options: { batch?: string; env?: ClientEnv } = {},
): Promise<{ batch: string | null; restored: string[]; conflicts: string[] }> {
  const env = options.env ?? defaultClientEnv();
  const journal = await readJournal();
  const batch =
    options.batch ??
    [...journal].reverse().find((entry) => !entry.restoreOf)?.batch ??
    null;
  const restored: string[] = [];
  const conflicts: string[] = [];
  if (!batch) return { batch, restored, conflicts };
  const entries = journal
    .filter(
      (entry) =>
        entry.batch === batch &&
        entry.op !== "hook-add" &&
        entry.op !== "native-set",
    )
    .reverse();
  const undo = newBatch();
  for (const file of [...new Set(entries.map((entry) => entry.file))]) {
    const adapter = CLIENT_ADAPTERS.find((item) => item.config?.file === file);
    if (!adapter?.config) continue;
    const config = adapter.config;
    // Collected per attempt: edit() may run the change again when the file moved under it.
    let fileRestored: string[] = [];
    let fileConflicts: string[] = [];
    await edit(
      path.join(env.home, file),
      (text) => {
        fileRestored = [];
        fileConflicts = [];
        const restored = fileRestored;
        const conflicts = fileConflicts;
        const read = config.editor.servers(text);
        if (!read) {
          conflicts.push(`${adapter.id}: config no longer readable`);
          return null;
        }
        const servers = new Map(read);
        const ops: Op[] = [];
        const queue = (op: Op) => {
          ops.push(op);
          simulate(servers, op);
        };
        const notes: Omit<JournalEntry, "batch" | "ts">[] = [];
        for (const entry of entries.filter((item) => item.file === file)) {
          const label = `${adapter.id}:${entry.key}`;
          if (entry.op === "rename" && entry.to) {
            if (servers.has(entry.to) && !servers.has(entry.key)) {
              queue({ kind: "rename", key: entry.to, to: entry.key });
              restored.push(label);
            } else conflicts.push(label);
          } else if (entry.op === "set") {
            if (!sameEntry(servers.get(entry.key), entry.after ?? {})) {
              conflicts.push(label);
              continue;
            }
            if (entry.before)
              queue({ kind: "set", key: entry.key, value: entry.before });
            else queue({ kind: "remove", key: entry.key });
            restored.push(
              entry.beforeSha
                ? `${label} (removed; original not stored)`
                : label,
            );
          } else if (entry.op === "remove") {
            if (servers.has(entry.key) || !entry.before) {
              conflicts.push(label);
              continue;
            }
            queue({ kind: "set", key: entry.key, value: entry.before });
            restored.push(label);
          }
          notes.push({ ...entry, restoreOf: batch });
        }
        if (!ops.length) return null;
        return { next: config.editor.apply(text, ops), entries: notes };
      },
      undo,
    );
    restored.push(...fileRestored);
    conflicts.push(...fileConflicts);
  }
  return { batch, restored, conflicts };
}

// Starts the client's configured `ocean` command and checks it answers as the brain server.
// This proves the entry launches; it does not prove the client app connects to it.
export async function verifyClient(
  client: string,
  env: ClientEnv = defaultClientEnv(),
): Promise<{ client: string; ok: boolean; detail: string }> {
  const adapter = CLIENT_ADAPTERS.find((item) => item.id === client);
  if (!adapter?.config) return { client, ok: false, detail: "no MCP config" };
  const text = await readText(path.join(env.home, adapter.config.file));
  const entry = text
    ? adapter.config.editor.servers(text)?.get("ocean")
    : undefined;
  if (!entry || typeof entry.command !== "string")
    return { client, ok: false, detail: "no `ocean` entry" };
  return new Promise((resolve) => {
    const child = spawn(
      entry.command as string,
      (entry.args as string[]) ?? [],
      {
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    let output = "";
    let done = false;
    const finish = (ok: boolean, detail: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve({ client, ok, detail });
    };
    const timer = setTimeout(
      () => finish(false, "no answer within 15 s"),
      15_000,
    );
    child.on("error", (error) => finish(false, error.message));
    child.on("exit", (code) =>
      finish(false, `exited with code ${code} before answering`),
    );
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      // Only complete lines: a large reply (tools/list) arrives in several chunks.
      const replies = output
        .split("\n")
        .slice(0, -1)
        .filter((line) => line.startsWith("{"))
        .map(
          (line) =>
            JSON.parse(line) as {
              id?: number;
              result?: Record<string, unknown>;
            },
        );
      const init = replies.find((reply) => reply.id === 1);
      const list = replies.find((reply) => reply.id === 2);
      if (!init || !list) return;
      const name = (init.result?.serverInfo as { name?: string } | undefined)
        ?.name;
      const tools = ((list.result?.tools as { name: string }[]) ?? []).map(
        (tool) => tool.name,
      );
      const ok =
        name === "ocean" &&
        tools.includes("brain_search") &&
        tools.includes("memory_write");
      finish(
        ok,
        ok
          ? "answers as the ocean brain server with memory tools"
          : `serverInfo ${name}, ${tools.length} tools`,
      );
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "ocean-verify" } } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
    );
  });
}

export type ClientFinding = {
  code: string;
  severity: "OK" | "WARN" | "FAIL";
  message: string;
  fixable: boolean;
};

// Doctor view: a supported client that is installed but not wired fails; unsupported clients
// are reported with their fallback; an unknown capability is a warning, never a pass. On this
// machine's real env, an engine in a temporary directory is named first: every plan below then
// points at a build that will disappear (T-300).
// A wired client's status says only what its evidence proves: "checked in the app" is reserved
// for an in-app confirmation.
function evidenceFinding(
  name: string,
  client: string,
  record: ClientState["confirmed"][string] | undefined,
): ClientFinding {
  const confirm = `\`ocean clients confirm ${client} --label in-app --via <evidence>\``;
  const date = record?.confirmedAt.slice(0, 10);
  if (record?.label === "in-app")
    return {
      code: "CLIENT_WIRED",
      severity: "OK",
      message: `${name}: \`ocean\` entry current, checked in the app ${date} (${record.via})`,
      fixable: false,
    };
  if (record?.label === "blocked")
    return {
      code: "CLIENT_BLOCKED",
      severity: "WARN",
      message: `${name}: \`ocean\` entry current; in-app check blocked since ${date}: ${record.reason}`,
      fixable: false,
    };
  const proven = record?.label
    ? `${record.label} only (${date}${record.via ? `: ${record.via}` : ""})`
    : record
      ? `confirmed ${date} without an evidence label`
      : "in-app check not recorded";
  return {
    code: "CLIENT_CHECK_PENDING",
    severity: "WARN",
    message: `${name}: \`ocean\` entry current; ${proven} — ask it a question that needs Ocean, then ${confirm}`,
    fixable: false,
  };
}

export async function clientFindings(
  env?: ClientEnv,
): Promise<ClientFinding[]> {
  const findings: ClientFinding[] = [];
  const problem = env ? null : temporaryEntryProblem(defaultClientEnv().entry);
  if (problem)
    findings.push({
      code: "CLIENT_ENGINE_TEMPORARY",
      severity: "WARN",
      message: `the client plans below are for a temporary engine — ${problem}`,
      fixable: false,
    });
  env ??= defaultClientEnv();
  const { confirmed } = await readClientState();
  for (const plan of await planClients(env)) {
    if (!plan.installed) continue;
    const name = `${plan.label} (${plan.client})`;
    if (plan.status === "current")
      findings.push(evidenceFinding(name, plan.client, confirmed[plan.client]));
    else if (plan.status === "change")
      findings.push({
        code: "CLIENT_NOT_WIRED",
        severity: "FAIL",
        message: `${name}: ${plan.ops.map((op) => `${op.kind} ${op.key}`).join(", ")} pending in ${plan.file} — run \`ocean clients apply --yes\``,
        fixable: true,
      });
    else if (plan.status === "manual")
      findings.push({
        code: "CLIENT_MANUAL",
        severity: "FAIL",
        message: `${name}: needs a hand edit (${plan.reason}); add ${plan.snippet}`,
        fixable: false,
      });
    else if (plan.status === "unknown")
      findings.push({
        code: "CLIENT_UNKNOWN",
        severity: "WARN",
        message: `${name}: capability unknown — ${plan.reason}`,
        fixable: false,
      });
    else
      findings.push({
        code: "CLIENT_UNSUPPORTED",
        severity: "OK",
        message: `${name}: ${plan.status} — ${plan.reason}; fallback: ${plan.fallback}`,
        fixable: false,
      });
  }
  return findings;
}
