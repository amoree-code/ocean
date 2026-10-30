import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
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
  type NativeMemoryPolicy,
} from "./registry.js";

// Detect, plan, apply, restore and verify the `ocean` MCP entry in every installed client
// (T-296 P2). Only Ocean-managed entries are touched: `ocean` (the brain server), a legacy
// `ocean` that runs the Obsidian server (moved to `ocean-obsidian`) and dead entries of the
// retired atlas gateway. Rollback uses a journal of those entries' values — never a copy of a
// client's file, which can hold credentials next to its servers.

export type ClientEnv = {
  home: string;
  pathDirs: string[];
  appDirs: string[];
  entry: ServerValue;
};

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

type JournalEntry = {
  batch: string;
  ts: string;
  client: string;
  file: string;
  op: Op["kind"];
  key: string;
  to?: string;
  before: ServerValue | null;
  beforeSha?: string;
  after: ServerValue | null;
  restoreOf?: string;
};

export function defaultClientEnv(): ClientEnv {
  const home = os.homedir();
  return {
    home,
    pathDirs: (process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    appDirs:
      process.platform === "darwin"
        ? ["/Applications", path.join(home, "Applications")]
        : [],
    entry: {
      command: process.execPath,
      args: [liveEngineEntry(), "mcp", "serve"],
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
  return { ops };
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
      const { ops, manual } = opsFor(adapter, text, env.entry);
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
        plan.snippet = JSON.stringify({ ocean: env.entry });
    }
    plans.push(plan);
  }
  return plans;
}

function stateFile(): string {
  return oceanPath(SYSTEM_DIR, "state", "clients", "clients.json");
}

async function approvedClients(): Promise<
  Record<string, { approvedAt: string }>
> {
  const text = await readText(stateFile());
  return text ? (JSON.parse(text).approved ?? {}) : {};
}

async function approve(ids: string[]): Promise<void> {
  const file = stateFile();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await withFileLock(file, async () => {
    const approved = await approvedClients();
    for (const id of ids)
      approved[id] = { approvedAt: new Date().toISOString() };
    await atomicWrite(
      file,
      `${JSON.stringify({ approved }, null, 2)}\n`,
      0o600,
    );
  });
}

async function appendJournal(entries: JournalEntry[]): Promise<void> {
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

async function readJournal(): Promise<JournalEntry[]> {
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

const newBatch = () =>
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

export async function applyClients(
  options: { clients?: string[]; env?: ClientEnv } = {},
): Promise<{ batch: string; results: { client: string; result: string }[] }> {
  const env = options.env ?? defaultClientEnv();
  const batch = newBatch();
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
        const { ops, manual } = opsFor(adapter, text, env.entry);
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
export async function repairClients(env: ClientEnv = defaultClientEnv()) {
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
  const entries = journal.filter((entry) => entry.batch === batch).reverse();
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
// are reported with their fallback; an unknown capability is a warning, never a pass.
export async function clientFindings(
  env: ClientEnv = defaultClientEnv(),
): Promise<ClientFinding[]> {
  const findings: ClientFinding[] = [];
  for (const plan of await planClients(env)) {
    if (!plan.installed) continue;
    const name = `${plan.label} (${plan.client})`;
    if (plan.status === "current")
      findings.push({
        code: "CLIENT_WIRED",
        severity: "OK",
        message: `${name}: \`ocean\` entry current`,
        fixable: false,
      });
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
