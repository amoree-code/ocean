import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type ClientEnv,
  defaultClientEnv,
  edit,
  newBatch,
  planClients,
  readJournal,
  temporaryEntryProblem,
} from "./clients.js";
import { canonicalJson, ManualEdit } from "./editors.js";

// Ocean's session-start hook in every client whose session-start event is VERIFIED (T-296 P3b).
// Claude Code and Codex read `hookSpecificOutput.additionalContext`; so does Gemini CLI 0.58
// (fireSessionStartEvent → getAdditionalContext, wrapped in <hook_context>). Only a missing
// Ocean hook is added, as one new group after the user's own: existing groups — other tools'
// hooks, or an Ocean hook that already runs — are never edited.

// Each client runs a hook line in its own shell on Windows, and no quoting works in all of them.
// Claude Code: Git Bash, or PowerShell without it, so its hook names PowerShell (`shell`). Codex:
// %COMSPEC% /C "<line>". Gemini CLI: PowerShell -Command.

type HookGroup = Record<string, unknown>;

type WindowsShell = "cmd" | "powershell";

type HookAdapter = {
  client: string;
  // The `--client` value of `ocean hook session-start`.
  hookClient: string;
  file: string;
  windowsShell: WindowsShell;
  group(command: string, windows: boolean): HookGroup;
};

// `platform` is for tests; the running platform otherwise.
type HookEnv = ClientEnv & { platform?: NodeJS.Platform };

export const HOOK_ADAPTERS: HookAdapter[] = [
  {
    client: "claude-code",
    hookClient: "claude",
    file: ".claude/settings.json",
    windowsShell: "powershell",
    group: (command, windows) => ({
      hooks: [
        {
          type: "command",
          command,
          ...(windows ? { shell: "powershell" } : {}),
          timeout: 10,
        },
      ],
    }),
  },
  {
    client: "codex",
    hookClient: "codex",
    file: ".codex/hooks.json",
    windowsShell: "cmd",
    group: (command) => ({
      matcher: "startup|resume",
      hooks: [
        {
          type: "command",
          command,
          timeout: 10,
          statusMessage: "Loading Ocean context",
        },
      ],
    }),
  },
  {
    client: "gemini",
    hookClient: "gemini",
    file: ".gemini/settings.json",
    windowsShell: "powershell",
    // Gemini's hook timeout is in milliseconds.
    group: (command) => ({
      matcher: "*",
      hooks: [{ name: "ocean", type: "command", command, timeout: 10_000 }],
    }),
  },
];

const EVENT = "SessionStart";
const OCEAN_HOOK = /ocean-session-bootstrap|\bhook session-start\b/;

export type HookPlan = {
  client: string;
  file: string;
  status: "current" | "change" | "manual";
  reason?: string;
  snippet?: string;
};

const shellWord = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;

// A Windows path cannot hold `"`. PowerShell also closes a string on the typographic quotes.
const cmdWord = (word: string) => `"${word}"`;
const powershellWord = (word: string) =>
  `'${word.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`;

const isWindows = (env: HookEnv) =>
  (env.platform ?? process.platform) === "win32";

// `--repair` also starts `client sync` in the background, which re-applies approved clients.
export function hookCommand(env: HookEnv, hookClient: string): string {
  const program = Array.isArray(env.entry.args) ? env.entry.args[0] : "";
  const words = [String(env.entry.command), String(program)];
  const shell = isWindows(env)
    ? HOOK_ADAPTERS.find((item) => item.hookClient === hookClient)?.windowsShell
    : undefined;
  const invocation =
    shell === "cmd"
      ? words.map(cmdWord).join(" ")
      : shell === "powershell"
        ? `& ${words.map(powershellWord).join(" ")}`
        : words.map(shellWord).join(" ");
  return `${invocation} hook session-start --client ${hookClient} --repair`;
}

const hookGroup = (adapter: HookAdapter, env: HookEnv) =>
  adapter.group(hookCommand(env, adapter.hookClient), isWindows(env));

// The SessionStart group list, `[]` when absent; null when the file holds another shape there.
function sessionGroups(root: Record<string, unknown>): unknown[] | null {
  const hooks = root.hooks;
  if (hooks === undefined) return [];
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return null;
  const groups = (hooks as Record<string, unknown>)[EVENT];
  if (groups === undefined) return [];
  return Array.isArray(groups) ? groups : null;
}

const hasOceanHook = (groups: unknown[]) =>
  groups.some((group) => {
    const hooks = (group as { hooks?: unknown } | null)?.hooks;
    return (
      Array.isArray(hooks) &&
      hooks.some(
        (hook: { command?: unknown } | null) =>
          typeof hook?.command === "string" && OCEAN_HOOK.test(hook.command),
      )
    );
  });

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function planOne(text: string, adapter: HookAdapter, env: HookEnv): HookPlan {
  const plan: HookPlan = {
    client: adapter.client,
    file: `~/${adapter.file}`,
    status: "change",
  };
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(text.trim() ? text : "{}");
  } catch {
    return { ...plan, status: "manual", reason: "the file is not valid JSON" };
  }
  const groups = sessionGroups(root);
  if (!groups)
    return {
      ...plan,
      status: "manual",
      reason: `hooks.${EVENT} is not a list`,
    };
  if (hasOceanHook(groups)) return { ...plan, status: "current" };
  const group = hookGroup(adapter, env);
  try {
    canonicalJson(text);
  } catch (error) {
    if (!(error instanceof ManualEdit)) throw error;
    return {
      ...plan,
      status: "manual",
      reason: error.message,
      snippet: `hooks.${EVENT} += ${JSON.stringify(group)}`,
    };
  }
  return plan;
}

export async function planHooks(
  env: HookEnv = defaultClientEnv(),
): Promise<HookPlan[]> {
  const installed = new Set(
    (await planClients(env))
      .filter((plan) => plan.installed)
      .map((plan) => plan.client),
  );
  const plans: HookPlan[] = [];
  for (const adapter of HOOK_ADAPTERS)
    if (installed.has(adapter.client))
      plans.push(
        planOne(
          await readText(path.join(env.home, adapter.file)),
          adapter,
          env,
        ),
      );
  return plans;
}

// Appends the Ocean group where it is missing; journaled under `batch` so `ocean clients
// restore` undoes it together with the MCP entries of the same apply.
export async function applyHooks(
  options: {
    clients?: string[];
    env?: HookEnv;
    batch?: string;
    durable?: boolean;
  } = {},
): Promise<{ batch: string; results: { client: string; result: string }[] }> {
  const env = options.env ?? defaultClientEnv();
  if (options.durable ?? !options.env) {
    const problem = temporaryEntryProblem(env.entry);
    if (problem) throw new Error(`Refusing to add session hooks: ${problem}`);
  }
  const batch = options.batch ?? newBatch();
  const results: { client: string; result: string }[] = [];
  for (const plan of await planHooks(env)) {
    if (options.clients && !options.clients.includes(plan.client)) continue;
    if (plan.status !== "change") continue;
    const adapter = HOOK_ADAPTERS.find((item) => item.client === plan.client);
    if (!adapter) continue;
    const result = await edit(
      path.join(env.home, adapter.file),
      (text) => {
        if (planOne(text, adapter, env).status !== "change") return null;
        const { parsed, render } = canonicalJson(text);
        const created: string[] = [];
        if (parsed.hooks === undefined) {
          parsed.hooks = {};
          created.push("hooks");
        }
        const hooks = parsed.hooks as Record<string, unknown>;
        if (hooks[EVENT] === undefined) {
          hooks[EVENT] = [];
          created.push(EVENT);
        }
        const group = hookGroup(adapter, env);
        (hooks[EVENT] as unknown[]).push(group);
        return {
          next: render(parsed),
          entries: [
            {
              client: adapter.client,
              file: adapter.file,
              op: "hook-add",
              key: EVENT,
              before: null,
              after: group,
              created,
            },
          ],
        };
      },
      batch,
    );
    results.push({ client: plan.client, result });
  }
  return { batch, results };
}

// Removes the groups one apply batch added. A group the user changed or removed since is a
// conflict and left alone; keys the add created are removed again once empty.
export async function restoreHooks(options: {
  batch: string;
  env?: ClientEnv;
}): Promise<{ restored: string[]; conflicts: string[] }> {
  const env = options.env ?? defaultClientEnv();
  const entries = (await readJournal())
    .filter(
      (entry) =>
        entry.batch === options.batch &&
        entry.op === "hook-add" &&
        !entry.restoreOf,
    )
    .reverse();
  const restored: string[] = [];
  const conflicts: string[] = [];
  const undo = newBatch();
  for (const entry of entries) {
    const label = `${entry.client}:hook`;
    // Set per attempt: edit() may run the change again when the file moved under it.
    const outcome = { restored: false };
    await edit(
      path.join(env.home, entry.file),
      (text) => {
        outcome.restored = false;
        let document: ReturnType<typeof canonicalJson>;
        try {
          document = canonicalJson(text);
        } catch {
          return null;
        }
        const { parsed, render } = document;
        const groups = sessionGroups(parsed);
        const index =
          groups?.findIndex((group) => isDeepStrictEqual(group, entry.after)) ??
          -1;
        if (!groups || index < 0) return null;
        groups.splice(index, 1);
        const hooks = parsed.hooks as Record<string, unknown>;
        if (entry.created?.includes(EVENT) && groups.length === 0)
          delete hooks[EVENT];
        if (entry.created?.includes("hooks") && !Object.keys(hooks).length)
          delete parsed.hooks;
        outcome.restored = true;
        return {
          next: render(parsed),
          entries: [{ ...entry, restoreOf: options.batch }],
        };
      },
      undo,
    );
    (outcome.restored ? restored : conflicts).push(label);
  }
  return { restored, conflicts };
}
