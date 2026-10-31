import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { stagingDir } from "@ocean/brain/memory/memory-paths.js";
import {
  type ClientEnv,
  type ClientFinding,
  defaultClientEnv,
  edit,
  newBatch,
  planClients,
  readJournal,
} from "./clients.js";
import { canonicalJson, ManualEdit } from "./editors.js";

// Native-memory policy per client (T-296 §3.5, P4): keep each client's own memory store from
// becoming a second source of truth. Ocean sets only the switch it manages — Claude Code's
// memory directory → the staging folder, Gemini's and Qwen's `save_memory` tool excluded, Codex's
// `[memories]` off — journaled under the apply batch like the MCP entries and hooks. Hermes'
// YAML is read, never written: a manual step until its switches are off, then current. Any
// non-canonical JSON becomes a manual step with the exact setting too; clients whose
// memory lives on a server (Desktop/claude.ai, Cursor, ChatGPT) get the toggle to flip by hand,
// and Antigravity, which has no switch, is harvested into candidates instead.

type JsonSetting = {
  kind: "json-set" | "json-add";
  file: string;
  key: string[];
  value(env: ClientEnv): unknown;
};
type TomlSetting = {
  kind: "toml";
  file: string;
  section: string;
  values: Record<string, boolean>;
};
// A YAML switch Ocean only reads (T-300): `<section>:` at the top level, its keys one level in.
type YamlCheck = {
  client: string;
  kind: "yaml";
  file: string;
  section: string;
  values: Record<string, boolean>;
};
type NativeAdapter =
  | ({ client: string } & (JsonSetting | TomlSetting))
  | YamlCheck
  | { client: string; kind: "manual" | "toggle" | "harvest"; text: string };

export const NATIVE_ADAPTERS: NativeAdapter[] = [
  {
    client: "claude-code",
    kind: "json-set",
    file: ".claude/settings.json",
    key: ["autoMemoryDirectory"],
    value: () => stagingDir("claude-code"),
  },
  {
    client: "codex",
    kind: "toml",
    file: ".codex/config.toml",
    section: "memories",
    values: { generate_memories: false, use_memories: false },
  },
  {
    client: "gemini",
    kind: "json-add",
    file: ".gemini/settings.json",
    key: ["tools", "exclude"],
    value: () => "save_memory",
  },
  {
    client: "qwen",
    kind: "json-add",
    file: ".qwen/settings.json",
    key: ["tools", "exclude"],
    value: () => "save_memory",
  },
  {
    client: "hermes",
    kind: "yaml",
    file: ".hermes/config.yaml",
    section: "memory",
    values: { memory_enabled: false, user_profile_enabled: false },
  },
  {
    client: "claude-desktop",
    kind: "toggle",
    text: "turn off memory in Claude settings (account-wide, also claude.ai); import the export with `ocean memory import-claude`",
  },
  {
    client: "cursor",
    kind: "toggle",
    text: "turn off Memories in Cursor settings",
  },
  {
    client: "chatgpt",
    kind: "toggle",
    text: "turn off Memory in ChatGPT settings",
  },
  {
    client: "antigravity",
    kind: "harvest",
    text: "no switch: `ocean memory harvest --source antigravity` turns its brain notes into candidates",
  },
];

type SettingAdapter = { client: string } & (JsonSetting | TomlSetting);
const hasSetting = (adapter: NativeAdapter): adapter is SettingAdapter =>
  "file" in adapter && adapter.kind !== "yaml";

export type NativePlan = {
  client: string;
  status: "current" | "change" | "manual" | "toggle" | "harvest";
  file?: string;
  setting?: string;
  reason?: string;
};

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

const settingLabel = (adapter: JsonSetting | TomlSetting, env: ClientEnv) =>
  adapter.kind === "toml"
    ? `[${adapter.section}] ${Object.entries(adapter.values)
        .map(([key, value]) => `${key} = ${value}`)
        .join(", ")}`
    : `${adapter.key.join(".")} ${adapter.kind === "json-add" ? "+=" : "="} ${JSON.stringify(adapter.value(env))}`;

function nodeAt(root: Record<string, unknown>, key: string[]): unknown {
  let node: unknown = root;
  for (const part of key)
    node =
      node && typeof node === "object" && !Array.isArray(node)
        ? (node as Record<string, unknown>)[part]
        : undefined;
  return node;
}

function desiredJson(
  adapter: JsonSetting,
  current: unknown,
  env: ClientEnv,
): unknown {
  const value = adapter.value(env);
  if (adapter.kind === "json-set") return value;
  const list = Array.isArray(current) ? current : [];
  return list.includes(value) ? list : [...list, value];
}

// TOML: the managed keys inside one `[section]`, read and set line by line.
const tomlLine = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)`);

function tomlSection(lines: string[], section: string) {
  const start = lines.findIndex((line) => line.trim() === `[${section}]`);
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++)
    if (/^\s*\[/.test(lines[index])) {
      end = index;
      break;
    }
  // The section ends at its last non-blank line: new keys go there, before any blank
  // separator (or the file's final newline).
  while (end - 1 > start && !lines[end - 1].trim()) end -= 1;
  return { start, end };
}

function tomlValues(text: string, adapter: TomlSetting) {
  const lines = text.split("\n");
  const range = tomlSection(lines, adapter.section);
  const values: Record<string, string | null> = {};
  for (const key of Object.keys(adapter.values)) {
    const line = range
      ? lines
          .slice(range.start + 1, range.end)
          .find((item) => tomlLine(key).test(item))
      : undefined;
    values[key] = line ? (tomlLine(key).exec(line)?.[1] ?? null) : null;
  }
  return { values, hasSection: Boolean(range) };
}

function setToml(
  text: string,
  section: string,
  values: Record<string, string | null>,
  dropEmptySection: boolean,
): string {
  const lines = text.split("\n");
  let range = tomlSection(lines, section);
  if (!range) {
    const tail = lines.at(-1) === "" ? lines.length - 1 : lines.length;
    const block = [
      ...(tail && lines[tail - 1].trim() ? [""] : []),
      `[${section}]`,
    ];
    lines.splice(tail, 0, ...block);
    range = tomlSection(lines, section) as { start: number; end: number };
  }
  for (const [key, value] of Object.entries(values)) {
    const at = lines.findIndex(
      (line, index) =>
        index > range.start && index < range.end && tomlLine(key).test(line),
    );
    if (value === null) {
      if (at >= 0) {
        lines.splice(at, 1);
        range.end -= 1;
      }
    } else if (at >= 0) lines[at] = `${key} = ${value}`;
    else {
      lines.splice(range.end, 0, `${key} = ${value}`);
      range.end += 1;
    }
  }
  if (dropEmptySection) {
    const body = lines.slice(range.start + 1, range.end);
    if (body.every((line) => !line.trim())) {
      const before = range.start > 0 && !lines[range.start - 1].trim() ? 1 : 0;
      lines.splice(range.start - before, range.end - range.start + before);
    }
  }
  return lines.join("\n");
}

function planOne(
  text: string,
  adapter: SettingAdapter,
  env: ClientEnv,
): NativePlan {
  const plan: NativePlan = {
    client: adapter.client,
    status: "change",
    file: `~/${adapter.file}`,
    setting: settingLabel(adapter, env),
  };
  if (adapter.kind === "toml") {
    const { values } = tomlValues(text, adapter);
    const done = Object.entries(adapter.values).every(
      ([key, value]) => values[key] === String(value),
    );
    return done ? { ...plan, status: "current" } : plan;
  }
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(text.trim() ? text : "{}");
  } catch {
    return { ...plan, status: "manual", reason: "the file is not valid JSON" };
  }
  const current = nodeAt(root, adapter.key);
  if (isDeepStrictEqual(current, desiredJson(adapter, current, env)))
    return { ...plan, status: "current" };
  try {
    canonicalJson(text);
  } catch (error) {
    if (!(error instanceof ManualEdit)) throw error;
    return { ...plan, status: "manual", reason: error.message };
  }
  return plan;
}

function yamlValues(text: string, section: string) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === `${section}:`);
  const values: Record<string, string> = {};
  if (start < 0) return values;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) break;
    const match = /^\s+([A-Za-z0-9_-]+):\s*([^\s#]+)/.exec(line);
    if (match && !(match[1] in values)) values[match[1]] = match[2];
  }
  return values;
}

function planYaml(text: string, adapter: YamlCheck): NativePlan {
  const values = yamlValues(text, adapter.section);
  const done = Object.entries(adapter.values).every(
    ([key, value]) => values[key] === String(value),
  );
  return {
    client: adapter.client,
    status: done ? "current" : "manual",
    file: `~/${adapter.file}`,
    setting: Object.entries(adapter.values)
      .map(([key, value]) => `${adapter.section}.${key}: ${value}`)
      .join(", "),
    ...(done ? {} : { reason: "Ocean does not rewrite YAML; set it by hand" }),
  };
}

export async function planNative(
  env: ClientEnv = defaultClientEnv(),
): Promise<NativePlan[]> {
  const installed = new Set(
    (await planClients(env))
      .filter((plan) => plan.installed)
      .map((plan) => plan.client),
  );
  const plans: NativePlan[] = [];
  for (const adapter of NATIVE_ADAPTERS) {
    if (!installed.has(adapter.client)) continue;
    if (adapter.kind === "yaml")
      plans.push(
        planYaml(await readText(path.join(env.home, adapter.file)), adapter),
      );
    else if (!hasSetting(adapter))
      plans.push({
        client: adapter.client,
        status: adapter.kind,
        reason: adapter.text,
      });
    else
      plans.push(
        planOne(
          await readText(path.join(env.home, adapter.file)),
          adapter,
          env,
        ),
      );
  }
  return plans;
}

export async function applyNative(
  options: { clients?: string[]; env?: ClientEnv; batch?: string } = {},
): Promise<{ batch: string; results: { client: string; result: string }[] }> {
  const env = options.env ?? defaultClientEnv();
  const batch = options.batch ?? newBatch();
  const results: { client: string; result: string }[] = [];
  for (const plan of await planNative(env)) {
    if (plan.status !== "change") continue;
    if (options.clients && !options.clients.includes(plan.client)) continue;
    const adapter = NATIVE_ADAPTERS.find((item) => item.client === plan.client);
    if (!adapter || !hasSetting(adapter)) continue;
    const result = await edit(
      path.join(env.home, adapter.file),
      (text) => {
        if (planOne(text, adapter, env).status !== "change") return null;
        const entry = {
          client: adapter.client,
          file: adapter.file,
          op: "native-set" as const,
          key:
            adapter.kind === "toml" ? adapter.section : adapter.key.join("."),
        };
        if (adapter.kind === "toml") {
          const { values, hasSection } = tomlValues(text, adapter);
          const after = Object.fromEntries(
            Object.entries(adapter.values).map(([key, value]) => [
              key,
              String(value),
            ]),
          );
          return {
            next: setToml(text, adapter.section, after, false),
            entries: [
              {
                ...entry,
                before: values,
                after,
                created: hasSection ? [] : [adapter.section],
              },
            ],
          };
        }
        const { parsed, render } = canonicalJson(text);
        const before = nodeAt(parsed, adapter.key);
        const after = desiredJson(adapter, before, env);
        const created: string[] = [];
        let node = parsed;
        for (const part of adapter.key.slice(0, -1)) {
          if (node[part] === undefined) {
            node[part] = {};
            created.push(part);
          }
          node = node[part] as Record<string, unknown>;
        }
        node[adapter.key.at(-1) as string] = after;
        return {
          next: render(parsed),
          entries: [
            {
              ...entry,
              before: before === undefined ? null : { value: before },
              after: { value: after },
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

// Puts each setting one apply batch changed back to its value before, when it still holds what
// Ocean wrote; otherwise it is a conflict and left alone.
export async function restoreNative(options: {
  batch: string;
  env?: ClientEnv;
}): Promise<{ restored: string[]; conflicts: string[] }> {
  const env = options.env ?? defaultClientEnv();
  const entries = (await readJournal())
    .filter(
      (entry) =>
        entry.batch === options.batch &&
        entry.op === "native-set" &&
        !entry.restoreOf,
    )
    .reverse();
  const restored: string[] = [];
  const conflicts: string[] = [];
  const undo = newBatch();
  for (const entry of entries) {
    const adapter = NATIVE_ADAPTERS.find(
      (item) => item.client === entry.client,
    );
    if (!adapter || !hasSetting(adapter)) continue;
    const outcome = { restored: false };
    await edit(
      path.join(env.home, entry.file),
      (text) => {
        outcome.restored = false;
        let next: string;
        if (adapter.kind === "toml") {
          const { values } = tomlValues(text, adapter);
          if (!isDeepStrictEqual(values, entry.after)) return null;
          next = setToml(
            text,
            adapter.section,
            entry.before as Record<string, string | null>,
            Boolean(entry.created?.length),
          );
        } else {
          let document: ReturnType<typeof canonicalJson>;
          try {
            document = canonicalJson(text);
          } catch {
            return null;
          }
          const { parsed, render } = document;
          if (
            !isDeepStrictEqual(nodeAt(parsed, adapter.key), entry.after?.value)
          )
            return null;
          const parents = [parsed];
          for (const part of adapter.key.slice(0, -1))
            parents.push(parents.at(-1)?.[part] as Record<string, unknown>);
          const leaf = parents.at(-1) as Record<string, unknown>;
          if (entry.before)
            leaf[adapter.key.at(-1) as string] = entry.before.value;
          else delete leaf[adapter.key.at(-1) as string];
          for (let depth = adapter.key.length - 2; depth >= 0; depth--) {
            const part = adapter.key[depth];
            if (
              entry.created?.includes(part) &&
              !Object.keys(parents[depth + 1]).length
            )
              delete parents[depth][part];
          }
          next = render(parsed);
        }
        outcome.restored = true;
        return { next, entries: [{ ...entry, restoreOf: options.batch }] };
      },
      undo,
    );
    (outcome.restored ? restored : conflicts).push(`${entry.client}:native`);
  }
  return { restored, conflicts };
}

// Doctor view (§3.8): a switch Ocean can set but has not is a competing source (FAIL); a toggle
// on a server or a store with no switch cannot be checked from here (WARN).
export async function nativeFindings(
  env: ClientEnv = defaultClientEnv(),
): Promise<ClientFinding[]> {
  return (await planNative(env)).map((plan) => {
    const name = `${plan.client} native memory`;
    if (plan.status === "current")
      return {
        code: "NATIVE_POLICY_SET",
        severity: "OK" as const,
        message: `${name}: ${plan.setting} (confirm in the app that nothing new lands in its own store)`,
        fixable: false,
      };
    if (plan.status === "change" || plan.status === "manual")
      return {
        code: "NATIVE_COMPETING",
        severity: "FAIL" as const,
        message: `${name}: competing source — ${plan.status === "change" ? `run \`ocean clients apply --yes\` (${plan.setting} in ${plan.file})` : `hand edit: ${plan.setting} in ${plan.file} (${plan.reason})`}`,
        fixable: plan.status === "change",
      };
    return {
      code:
        plan.status === "toggle" ? "NATIVE_TOGGLE_PENDING" : "NATIVE_HARVEST",
      severity: "WARN" as const,
      message: `${name}: ${plan.reason}`,
      fixable: false,
    };
  });
}
