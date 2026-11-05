import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import {
  appendJournal,
  type ClientEnv,
  defaultClientEnv,
  edit,
  newBatch,
  planClients,
  readJournal,
  temporaryEntryProblem,
} from "./clients.js";

// OpenCode has no shell hooks; its plugins do (T-307). Ocean owns one plugin file that, once per
// OpenCode session, runs `ocean hook session-start --client opencode` and adds the bounded start
// line to that session's system prompt (`experimental.chat.system.transform`, OpenCode 1.18).
// OpenCode fires no event when a session ends (`session.deleted` is a deletion), so there is no
// session-end hook. The file is Ocean's alone: written whole, journaled, removed on restore.

export const OPENCODE_PLUGIN_FILE = ".config/opencode/plugins/ocean.js";
const MARKER = "// Ocean session context for OpenCode";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

// The engine invocation the plugin spawns (no shell: argv words only).
function invocation(env: ClientEnv): string[] {
  const program = Array.isArray(env.entry.args)
    ? String(env.entry.args[0])
    : "";
  return program === "mcp"
    ? [String(env.entry.command)]
    : [String(env.entry.command), program];
}

export function opencodePluginSource(env: ClientEnv): string {
  return `${MARKER} (written by \`ocean clients apply\`; \`ocean clients restore\` removes it).
import { spawn } from "node:child_process";

const OCEAN = ${JSON.stringify(invocation(env))};
const contexts = new Map();

function startLine(sessionID, directory) {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(OCEAN[0], [...OCEAN.slice(1), "hook", "session-start", "--client", "opencode"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const timer = setTimeout(() => child.kill(), 10000);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", () => resolve(""));
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out).hookSpecificOutput?.additionalContext ?? "");
      } catch {
        resolve("");
      }
    });
    child.stdin.end(JSON.stringify({ session_id: sessionID, cwd: directory ?? "" }));
  });
}

export const OceanContext = async ({ directory }) => ({
  "experimental.chat.system.transform": async (input, output) => {
    const id = input?.sessionID;
    if (!id || !Array.isArray(output?.system)) return;
    if (!contexts.has(id)) contexts.set(id, startLine(id, directory));
    const line = await contexts.get(id);
    if (line) output.system.push(line);
  },
});
`;
}

export type OpencodePluginPlan = {
  client: "opencode";
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

function planText(text: string | null, want: string): OpencodePluginPlan {
  const plan = {
    client: "opencode" as const,
    file: `~/${OPENCODE_PLUGIN_FILE}`,
  };
  if (text === want) return { ...plan, status: "current" };
  if (text === null || text.startsWith(MARKER))
    return { ...plan, status: "change" };
  return {
    ...plan,
    status: "manual",
    reason: "a plugin Ocean did not write already has this name",
  };
}

export async function planOpencodePlugin(
  env: ClientEnv = defaultClientEnv(),
): Promise<OpencodePluginPlan[]> {
  const installed = (await planClients(env)).some(
    (plan) => plan.client === "opencode" && plan.installed,
  );
  if (!installed) return [];
  const text = await readIfPresent(path.join(env.home, OPENCODE_PLUGIN_FILE));
  return [planText(text, opencodePluginSource(env))];
}

export async function applyOpencodePlugin(
  options: {
    clients?: string[];
    env?: ClientEnv;
    batch?: string;
    durable?: boolean;
  } = {},
): Promise<{ batch: string; results: { client: string; result: string }[] }> {
  const env = options.env ?? defaultClientEnv();
  const batch = options.batch ?? newBatch();
  if (options.clients && !options.clients.includes("opencode"))
    return { batch, results: [] };
  if (options.durable ?? !options.env) {
    const problem = temporaryEntryProblem(env.entry);
    if (problem)
      throw new Error(`Refusing to add the OpenCode plugin: ${problem}`);
  }
  const plans = await planOpencodePlugin(env);
  if (plans[0]?.status !== "change") return { batch, results: [] };
  const want = opencodePluginSource(env);
  const result = await edit(
    path.join(env.home, OPENCODE_PLUGIN_FILE),
    (text) => {
      const current = text === "" ? null : text;
      if (planText(current, want).status !== "change") return null;
      return {
        next: want,
        entries: [
          {
            client: "opencode",
            file: OPENCODE_PLUGIN_FILE,
            op: "hook-add",
            key: "plugin",
            before: current === null ? null : { sha256: sha(current) },
            after: { sha256: sha(want) },
          },
        ],
      };
    },
    batch,
  );
  return { batch, results: [{ client: "opencode", result }] };
}

// Removes the plugin one apply batch wrote, unless it changed since (a conflict, left alone).
// A plugin that replaced an older Ocean plugin is removed too; the next apply writes it again.
export async function restoreOpencodePlugin(options: {
  batch: string;
  env?: ClientEnv;
}): Promise<{ restored: string[]; conflicts: string[] }> {
  const env = options.env ?? defaultClientEnv();
  const entries = (await readJournal()).filter(
    (entry) =>
      entry.batch === options.batch &&
      entry.client === "opencode" &&
      entry.key === "plugin" &&
      !entry.restoreOf,
  );
  const restored: string[] = [];
  const conflicts: string[] = [];
  for (const entry of entries) {
    const file = path.join(env.home, entry.file);
    const text = await readIfPresent(file);
    const after = (entry.after as { sha256?: string } | null)?.sha256;
    if (text === null || sha(text) !== after) {
      conflicts.push("opencode:plugin");
      continue;
    }
    await unlink(file);
    await appendJournal([
      {
        ...entry,
        batch: newBatch(),
        ts: new Date().toISOString(),
        restoreOf: options.batch,
      },
    ]);
    restored.push("opencode:plugin");
  }
  return { restored, conflicts };
}
