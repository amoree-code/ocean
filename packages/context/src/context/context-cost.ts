import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clientSkillRoots,
  type SkillClient,
} from "@ocean/market/skills/core-skill-sync.js";

// Read-only measurement of each client's always-on context: the text an interactive client
// loads on every request before the user types anything (global rules, an auto-loaded memory
// index, the frontmatter of every model-visible skill, and for Claude its commands, agents
// and enabled plugins). Reports only display paths (~/...),
// byte counts and fixed notes — never file contents and never raw error messages, which can
// carry absolute paths.

export const DEFAULT_CONTEXT_BUDGET = 12_288;

export type MeasuredFile = {
  path: string;
  bytes: number;
  via?: string;
  missing?: true;
  unreadable?: true;
};

export type ClientContextCost = {
  client: SkillClient | "agents";
  shared: boolean;
  rules: MeasuredFile[];
  memory: MeasuredFile[];
  skills: {
    root: string;
    present: boolean;
    count: number;
    frontmatterBytes: number;
    bodyBytes: number;
    // Installed but kept out of the model's listing (a client setting or the skill's own
    // `disable-model-invocation`), so not always-on and not in the counts above.
    hidden: number;
    hiddenFrontmatterBytes: number;
  };
  // Other always-on listings: Claude's commands, agents and enabled plugins.
  extras: MeasuredFile[];
  alwaysOnBytes: number;
  overBudget: boolean;
  notes: string[];
};

export type ContextCostReport = {
  budget: number;
  project: string | null;
  clients: ClientContextCost[];
};

type Sources = {
  // Home-relative alternatives in precedence order; the first that exists wins. When none
  // exists the last (the canonical file) is reported missing.
  rules: string[];
  // Resolve Claude/Gemini-style `@path` imports one level.
  imports: boolean;
  // Scan one directory level deeper for skills (category layouts, hidden system dirs).
  nested: boolean;
  skillsRoot: (home: string) => string;
  shared?: boolean;
  notes: string[];
};

// Keyed by every SkillClient, so TypeScript forces an entry when a client is added.
const clientSources: Record<SkillClient, Sources> & { agents: Sources } = {
  claude: {
    rules: [".claude/CLAUDE.md"],
    imports: true,
    nested: false,
    skillsRoot: clientSkillRoots.claude,
    notes: ["project-level CLAUDE.md/AGENTS.md walk-up is not measured"],
  },
  codex: {
    rules: [".codex/AGENTS.override.md", ".codex/AGENTS.md"],
    imports: false,
    nested: true,
    skillsRoot: clientSkillRoots.codex,
    notes: ["assumed: AGENTS.override.md precedence and ~/.agents usage"],
  },
  gemini: {
    rules: [".gemini/GEMINI.md"],
    imports: true,
    nested: false,
    skillsRoot: clientSkillRoots.gemini,
    notes: [],
  },
  hermes: {
    rules: [".hermes/SOUL.md"],
    imports: false,
    nested: true,
    skillsRoot: clientSkillRoots.hermes,
    notes: [
      "assumed: SOUL.md is the always-on rules file",
      "memories are not counted (auto-load unverified)",
    ],
  },
  cursor: {
    rules: [],
    imports: false,
    nested: false,
    skillsRoot: clientSkillRoots.cursor,
    notes: ["user rules live in the app settings store, not a file"],
  },
  antigravity: {
    rules: [],
    imports: false,
    nested: false,
    skillsRoot: clientSkillRoots.antigravity,
    notes: ["global rules location not known to the engine"],
  },
  agents: {
    rules: [],
    imports: false,
    nested: false,
    skillsRoot: (home) => path.join(home, ".agents", "skills"),
    shared: true,
    notes: [
      "shared skills root; clients that symlink into it count the same files",
    ],
  },
};

export function displayPath(abs: string, home: string): string {
  const relative = path.relative(home, abs);
  if (!relative) return "~";
  if (!relative.startsWith("..") && !path.isAbsolute(relative))
    return `~/${relative.split(path.sep).join("/")}`;
  return `<outside-home>/${path.basename(abs)}`;
}

async function sizeOf(file: string): Promise<number | null> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

async function isDirectory(target: string): Promise<boolean | null> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return null;
  }
}

const IMPORT_TOKEN = /(?:^|\s)@(\S+)/g;

// `@path` tokens outside code fences and inline code spans that look like a path (so
// `@handle` mentions are ignored).
function importTargets(text: string): string[] {
  const targets: string[] = [];
  let fenced = false;
  for (const raw of text.split("\n")) {
    if (raw.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const line = raw.replace(/`[^`]*`/g, " ");
    for (const match of line.matchAll(IMPORT_TOKEN)) {
      const token = match[1];
      if (
        /^(~\/|\.\/|\.\.\/|\/)/.test(token) ||
        token.includes("/") ||
        token.endsWith(".md")
      )
        targets.push(token);
    }
  }
  return targets;
}

function resolveImport(token: string, includer: string, home: string): string {
  if (token.startsWith("~/")) return path.join(home, token.slice(2));
  if (path.isAbsolute(token)) return token;
  return path.resolve(path.dirname(includer), token);
}

async function measureRules(
  sources: Sources,
  home: string,
): Promise<MeasuredFile[]> {
  if (!sources.rules.length) return [];
  let chosen: string | null = null;
  let bytes: number | null = null;
  for (const candidate of sources.rules) {
    const file = path.join(home, candidate);
    bytes = await sizeOf(file);
    if (bytes !== null) {
      chosen = file;
      break;
    }
  }
  if (chosen === null || bytes === null) {
    const canonical = path.join(home, sources.rules[sources.rules.length - 1]);
    return [{ path: displayPath(canonical, home), bytes: 0, missing: true }];
  }
  const rules: MeasuredFile[] = [{ path: displayPath(chosen, home), bytes }];
  if (!sources.imports) return rules;
  let text: string;
  try {
    text = await readFile(chosen, "utf8");
  } catch {
    rules[0].unreadable = true;
    return rules;
  }
  const seen = new Set<string>([chosen]);
  const via = displayPath(chosen, home);
  for (const token of importTargets(text)) {
    const target = resolveImport(token, chosen, home);
    if (seen.has(target)) continue;
    seen.add(target);
    const size = await sizeOf(target);
    rules.push(
      size === null
        ? { path: displayPath(target, home), bytes: 0, via, missing: true }
        : { path: displayPath(target, home), bytes: size, via },
    );
  }
  return rules;
}

// Walks up the path string (never realpath'd, matching how the slug is built) to the nearest
// `.git`. A `.git` directory marks the root; a `.git` file is a linked worktree (or a
// submodule), followed through `gitdir:` and `commondir` to the main checkout when it has
// one. Only git metadata is read, and nothing from it is reported.
async function memoryProjectRoot(projectDir: string): Promise<string> {
  let current = projectDir;
  for (;;) {
    const dotGit = path.join(current, ".git");
    const info = await stat(dotGit).catch(() => null);
    if (info?.isDirectory()) return current;
    if (info?.isFile()) return (await worktreeMainRoot(dotGit)) ?? current;
    const parent = path.dirname(current);
    if (parent === current) return projectDir;
    current = parent;
  }
}

async function worktreeMainRoot(dotGitFile: string): Promise<string | null> {
  try {
    const match = /^gitdir:[ \t]*(.+)$/m.exec(
      await readFile(dotGitFile, "utf8"),
    );
    if (!match) return null;
    const gitDir = path.resolve(path.dirname(dotGitFile), match[1].trim());
    const commonDir = path.resolve(
      gitDir,
      (await readFile(path.join(gitDir, "commondir"), "utf8")).trim(),
    );
    return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : null;
  } catch {
    return null;
  }
}

async function measureMemory(
  client: SkillClient | "agents",
  home: string,
  projectDir: string | null,
  notes: string[],
): Promise<MeasuredFile[]> {
  if (client !== "claude") return [];
  if (!projectDir) {
    notes.push("claude per-project memory skipped; pass --project <dir>");
    return [];
  }
  // Claude keys auto-memory by the project's git repository root (every subdirectory and
  // worktree of one repo shares it), falling back to the directory itself outside a repo.
  // The slug is that path string with every non-alphanumeric character replaced by '-'. It
  // encodes an absolute path, so it is never displayed.
  const slug = (await memoryProjectRoot(projectDir)).replace(
    /[^a-zA-Z0-9]/g,
    "-",
  );
  const file = path.join(
    home,
    ".claude",
    "projects",
    slug,
    "memory",
    "MEMORY.md",
  );
  const display = "~/.claude/projects/<project-slug>/memory/MEMORY.md";
  notes.push("Claude loads up to the first 200 lines; whole-file bytes shown");
  const bytes = await sizeOf(file);
  return bytes === null
    ? [{ path: display, bytes: 0, missing: true }]
    : [{ path: display, bytes }];
}

// Frontmatter is the leading `---` line through the closing `---` line inclusive.
function frontmatterBytes(buffer: Buffer): number {
  const text = buffer.toString("utf8");
  const open = /^---[ \t]*\r?\n/.exec(text);
  if (!open) return 0;
  const close = /\n---[ \t]*(\r?\n|$)/.exec(text.slice(open[0].length - 1));
  if (!close) return 0;
  const end = open[0].length - 1 + close.index + close[0].length;
  return Buffer.byteLength(text.slice(0, end));
}

// The `name:` and `disable-model-invocation:` of a frontmatter block — all the listing rules
// need. A missing name falls back to the directory or file name.
function frontmatterFields(
  buffer: Buffer,
  bytes: number,
): { name: string | null; modelHidden: boolean } {
  const text = buffer.subarray(0, bytes).toString("utf8");
  const name = /^name:[ \t]*["']?([^"'\r\n]+?)["']?[ \t]*$/m.exec(text)?.[1];
  return {
    name: name ?? null,
    modelHidden: /^disable-model-invocation:[ \t]*true[ \t]*$/m.test(text),
  };
}

// Claude's `skillOverrides` values that keep a skill out of the model's listing.
const HIDDEN_OVERRIDES = new Set(["off", "user-invocable-only"]);

type ClaudeSettings = {
  hidden: Set<string>;
  enabledPlugins: string[];
};

async function readClaudeSettings(
  home: string,
  notes: string[],
): Promise<ClaudeSettings> {
  const settings: ClaudeSettings = { hidden: new Set(), enabledPlugins: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(path.join(home, ".claude", "settings.json"), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      notes.push("settings.json unreadable; skill overrides not applied");
    return settings;
  }
  if (!parsed || typeof parsed !== "object") return settings;
  const { skillOverrides, enabledPlugins } = parsed as Record<string, unknown>;
  if (skillOverrides && typeof skillOverrides === "object")
    for (const [name, value] of Object.entries(skillOverrides))
      if (typeof value === "string" && HIDDEN_OVERRIDES.has(value))
        settings.hidden.add(name);
  if (enabledPlugins && typeof enabledPlugins === "object")
    settings.enabledPlugins = Object.entries(enabledPlugins)
      .filter(([, enabled]) => enabled === true)
      .map(([id]) => id);
  return settings;
}

// The skills the owner hid from Claude's model; `ocean client sync` hides the same ones from
// Codex and Gemini.
export async function claudeHiddenSkills(
  home = os.homedir(),
): Promise<Set<string>> {
  return (await readClaudeSettings(home, [])).hidden;
}

// The SKILL.md paths that `~/.codex/config.toml` disables with
// `[[skills.config]] path = "..." enabled = false`.
export async function codexDisabledSkillPaths(
  home = os.homedir(),
): Promise<Set<string>> {
  const disabled = new Set<string>();
  let text: string;
  try {
    text = await readFile(path.join(home, ".codex", "config.toml"), "utf8");
  } catch {
    return disabled;
  }
  let entry: { path?: string; enabled?: boolean } | null = null;
  const flush = () => {
    if (entry?.path && entry.enabled === false)
      disabled.add(path.resolve(entry.path));
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      flush();
      entry = line === "[[skills.config]]" ? {} : null;
      continue;
    }
    if (!entry) continue;
    const value = /^path\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(#.*)?$/.exec(
      line,
    )?.[1];
    if (value)
      try {
        entry.path = value.startsWith("'")
          ? value.slice(1, -1)
          : JSON.parse(value);
      } catch {
        // An unreadable path disables nothing.
      }
    const enabled = /^enabled\s*=\s*(true|false)\s*(#.*)?$/.exec(line)?.[1];
    if (enabled) entry.enabled = enabled === "true";
  }
  flush();
  return disabled;
}

// `skills.disabled` of `~/.hermes/config.yaml`, read line by line (no YAML dependency): a
// top-level `skills:` block whose `disabled:` is a block list (`- name`, indented or not) or a
// flow list (`[a, b]`). Line indexes let `ocean client sync` rewrite exactly that key. `null`
// for a shape this reader does not understand — then nothing may be written.
export type HermesDisabled = {
  names: string[];
  lines: string[];
  // Index of the `skills:` line, or -1 when there is none.
  skills: number;
  // Half-open line range of the `disabled:` key and its items, or null when absent.
  disabled: [number, number] | null;
  indent: string;
};

const unquoteName = (value: string) =>
  value.trim().replace(/^(["'])(.*)\1$/, "$2");

export function readHermesDisabled(text: string): HermesDisabled | null {
  const lines = text.split("\n");
  const skills = lines.findIndex((line) => /^skills:\s*(#.*)?$/.test(line));
  if (skills < 0)
    return lines.some((line) => /^skills\s*:/.test(line))
      ? null
      : { names: [], lines, skills: -1, disabled: null, indent: "  " };
  let end = skills + 1;
  while (end < lines.length && !/^[^\s#]/.test(lines[end])) end += 1;
  const child = lines
    .slice(skills + 1, end)
    .find((line) => /^\s+[^\s#]/.test(line));
  const indent = child?.match(/^\s+/)?.[0] ?? "  ";
  const key = lines.findIndex(
    (line, index) =>
      index > skills &&
      index < end &&
      line.startsWith(`${indent}disabled:`) &&
      !line.startsWith(`${indent} `),
  );
  if (key < 0) return { names: [], lines, skills, disabled: null, indent };
  const value = lines[key]
    .slice(`${indent}disabled:`.length)
    .replace(/\s+#.*$/, "")
    .trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    const names = inner ? inner.split(",").map(unquoteName) : [];
    return names.every((name) => /^[\w.:-]+$/.test(name))
      ? { names, lines, skills, disabled: [key, key + 1], indent }
      : null;
  }
  if (value) return null;
  const names: string[] = [];
  let next = key + 1;
  for (; next < end; next += 1) {
    const line = lines[next];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = /^(\s*)-\s+(.+?)\s*$/.exec(line);
    if (!item || item[1].length < indent.length) break;
    const name = unquoteName(item[2]);
    if (!/^[\w.:-]+$/.test(name)) return null;
    names.push(name);
  }
  // Trailing blank lines stay outside the range.
  while (next > key + 1 && !lines[next - 1].trim()) next -= 1;
  return { names, lines, skills, disabled: [key, next], indent };
}

export async function hermesDisabledSkills(
  home = os.homedir(),
): Promise<Set<string>> {
  try {
    const text = await readFile(
      path.join(home, ".hermes", "config.yaml"),
      "utf8",
    );
    return new Set(readHermesDisabled(text)?.names ?? []);
  } catch {
    return new Set();
  }
}

// The skill names `~/.gemini/settings.json` lists under `skills.disabled`.
export async function geminiDisabledSkills(
  home = os.homedir(),
): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(home, ".gemini", "settings.json"), "utf8"),
    );
    const list = parsed?.skills?.disabled;
    return new Set(
      Array.isArray(list)
        ? list.filter((name): name is string => typeof name === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

// One always-on listing: the frontmatter of every model-visible `*.md` (or `<dir>/SKILL.md`
// when `skillDirs`) directly under `dir`. Hidden entries cost nothing.
async function listingBytes(
  dir: string,
  options: { skillDirs: boolean; hidden: (name: string) => boolean },
): Promise<number> {
  let entries: string[];
  try {
    entries = (await readdir(dir)).sort();
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const file = options.skillDirs
      ? path.join(dir, entry, "SKILL.md")
      : entry.endsWith(".md")
        ? path.join(dir, entry)
        : null;
    if (!file) continue;
    let buffer: Buffer;
    try {
      buffer = await readFile(file);
    } catch {
      continue;
    }
    const bytes = frontmatterBytes(buffer);
    const fields = frontmatterFields(buffer, bytes);
    const name = fields.name ?? entry.replace(/\.md$/, "");
    if (fields.modelHidden || options.hidden(name)) continue;
    total += bytes;
  }
  return total;
}

// Claude also lists custom commands, subagents and each enabled plugin's skills, commands
// and agents on every request; each is reported as one line.
async function measureClaudeExtras(
  home: string,
  settings: ClaudeSettings,
  notes: string[],
): Promise<MeasuredFile[]> {
  const claude = path.join(home, ".claude");
  const extras: MeasuredFile[] = [];
  const add = (dir: string, bytes: number) => {
    if (bytes) extras.push({ path: displayPath(dir, home), bytes });
  };
  const userHidden = (name: string) => settings.hidden.has(name);
  for (const kind of ["commands", "agents"])
    add(
      path.join(claude, kind),
      await listingBytes(path.join(claude, kind), {
        skillDirs: false,
        hidden: userHidden,
      }),
    );
  if (!settings.enabledPlugins.length) return extras;
  let installed: Record<string, { installPath?: unknown }[]> = {};
  try {
    installed =
      JSON.parse(
        await readFile(
          path.join(claude, "plugins", "installed_plugins.json"),
          "utf8",
        ),
      ).plugins ?? {};
  } catch {
    notes.push("installed_plugins.json unreadable; plugins not measured");
    return extras;
  }
  for (const id of settings.enabledPlugins) {
    const root = installed[id]?.[0]?.installPath;
    if (typeof root !== "string") continue;
    const plugin = id.split("@")[0];
    const hidden = (name: string) =>
      settings.hidden.has(`${plugin}:${name}`) || settings.hidden.has(name);
    let bytes = await listingBytes(path.join(root, "skills"), {
      skillDirs: true,
      hidden,
    });
    for (const kind of ["commands", "agents"])
      bytes += await listingBytes(path.join(root, kind), {
        skillDirs: false,
        hidden,
      });
    add(root, bytes);
  }
  return extras;
}

async function measureSkills(
  sources: Sources,
  home: string,
  notes: string[],
  hidden: (name: string, file: string) => boolean = () => false,
): Promise<ClientContextCost["skills"]> {
  const root = sources.skillsRoot(home);
  const result = {
    root: displayPath(root, home),
    present: false,
    count: 0,
    frontmatterBytes: 0,
    bodyBytes: 0,
    hidden: 0,
    hiddenFrontmatterBytes: 0,
  };
  let entries: string[];
  try {
    if (!(await isDirectory(root))) return result;
    entries = (await readdir(root)).sort();
  } catch {
    return result;
  }
  result.present = true;
  let broken = 0;
  const count = async (file: string) => {
    try {
      const buffer = await readFile(file);
      const frontmatter = frontmatterBytes(buffer);
      const fields = frontmatterFields(buffer, frontmatter);
      const name = fields.name ?? path.basename(path.dirname(file));
      if (fields.modelHidden || hidden(name, file)) {
        result.hidden += 1;
        result.hiddenFrontmatterBytes += frontmatter;
        return;
      }
      result.count += 1;
      result.frontmatterBytes += frontmatter;
      result.bodyBytes += buffer.byteLength - frontmatter;
    } catch {
      broken += 1;
    }
  };
  for (const name of entries) {
    if (name.startsWith(".") && !sources.nested) continue;
    const dir = path.join(root, name);
    const directory = await isDirectory(dir);
    if (directory === null) {
      broken += 1;
      continue;
    }
    if (!directory) continue;
    const skillFile = path.join(dir, "SKILL.md");
    if ((await sizeOf(skillFile)) !== null) {
      await count(skillFile);
      continue;
    }
    if (!sources.nested) continue;
    let children: string[];
    try {
      children = (await readdir(dir)).sort();
    } catch {
      broken += 1;
      continue;
    }
    for (const child of children) {
      const nestedFile = path.join(dir, child, "SKILL.md");
      if ((await sizeOf(nestedFile)) !== null) await count(nestedFile);
    }
  }
  if (broken)
    notes.push(`${broken} unreadable or broken skill entries skipped`);
  return result;
}

export async function measureContextCost(
  options: { home?: string; projectDir?: string | null; budget?: number } = {},
): Promise<ContextCostReport> {
  const home = options.home ?? os.homedir();
  const projectDir = options.projectDir ?? null;
  const budget = options.budget ?? DEFAULT_CONTEXT_BUDGET;
  const clients: ClientContextCost[] = [];
  for (const client of Object.keys(clientSources) as Array<
    SkillClient | "agents"
  >) {
    const sources = clientSources[client];
    const notes = [...sources.notes];
    const rules = await measureRules(sources, home);
    const memory = await measureMemory(client, home, projectDir, notes);
    const claude =
      client === "claude" ? await readClaudeSettings(home, notes) : null;
    const codexOff =
      client === "codex" ? await codexDisabledSkillPaths(home) : null;
    const geminiOff =
      client === "gemini" ? await geminiDisabledSkills(home) : null;
    const hermesOff =
      client === "hermes" ? await hermesDisabledSkills(home) : null;
    const skills = await measureSkills(sources, home, notes, (name, file) =>
      Boolean(
        claude?.hidden.has(name) ||
          codexOff?.has(path.resolve(file)) ||
          geminiOff?.has(name) ||
          hermesOff?.has(name),
      ),
    );
    const extras = claude ? await measureClaudeExtras(home, claude, notes) : [];
    const alwaysOnBytes =
      [...rules, ...memory, ...extras].reduce(
        (total, file) => total + file.bytes,
        0,
      ) + skills.frontmatterBytes;
    clients.push({
      client,
      shared: sources.shared ?? false,
      rules,
      memory,
      skills,
      extras,
      alwaysOnBytes,
      overBudget: alwaysOnBytes > budget,
      notes,
    });
  }
  return {
    budget,
    project: projectDir ? displayPath(projectDir, home) : null,
    clients,
  };
}
