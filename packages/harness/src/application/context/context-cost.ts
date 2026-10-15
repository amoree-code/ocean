import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clientSkillRoots,
  type SkillClient,
} from "../skills/core-skill-sync.js";

// Read-only measurement of each client's always-on context: the text an interactive client
// loads on every request before the user types anything (global rules, an auto-loaded memory
// index, and the frontmatter of every installed skill). Reports only display paths (~/...),
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
  };
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

async function measureSkills(
  sources: Sources,
  home: string,
  notes: string[],
): Promise<ClientContextCost["skills"]> {
  const root = sources.skillsRoot(home);
  const result = {
    root: displayPath(root, home),
    present: false,
    count: 0,
    frontmatterBytes: 0,
    bodyBytes: 0,
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
    const skills = await measureSkills(sources, home, notes);
    const alwaysOnBytes =
      [...rules, ...memory].reduce((total, file) => total + file.bytes, 0) +
      skills.frontmatterBytes;
    clients.push({
      client,
      shared: sources.shared ?? false,
      rules,
      memory,
      skills,
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
