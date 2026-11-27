import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWrite } from "@ocean/core/shared/fs-utils.js";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { projectSignals } from "@ocean/core/shared/repo-signals.js";
import {
  isContentWord,
  normalizeText,
  stem,
  tokenize,
} from "@ocean/core/shared/text-tokens.js";
import { clientSkillRoots } from "@ocean/market/skills/core-skill-sync.js";

// Skill router (T-325). A client only picks a skill by itself when the skill's description sits
// in its always-on context, which every request pays for; the owner hides most skills for that
// reason, so they never fire unasked. The router keeps the descriptions out of context instead:
// on every prompt a client hook (`ocean hook prompt`) scores the message against an index of
// every installed skill — deterministic word scoring, no model call — plus what the working
// directory holds, and above a threshold injects one line naming the skill file to read.
// Reading the file works for a hidden skill and in a client with no skill tool.

export type IndexedSkill = {
  name: string;
  description: string;
  // Phrases the description says the user types ("Use when the user says start my day, …").
  triggers: string[];
  // SKILL.md per client root that holds the skill (`agents` is the shared ~/.agents root).
  files: Record<string, string>;
};

export type SkillIndex = {
  version: 1;
  builtAt: number;
  skills: IndexedSkill[];
};

export type SkillMatch = {
  name: string;
  file: string;
  score: number;
  why: string[];
};

// Below this a match is noise; tuned on the owner's installed skills (`ocean skill route`).
export const ROUTE_THRESHOLD = 7;
// A runner-up within this share of the top score counts as close (named, or ambiguous).
const SECOND_RATIO = 0.8;
// What a word found in only one skill is worth (≈ its raw IDF across ~150 skills).
const IDF_CEILING = 4.6;
// Long pastes (logs, exports) are routed on their opening only.
const MESSAGE_CHARS = 1_500;

type Root = { client: string; dir: string; nested: boolean };

function skillRoots(home: string): Root[] {
  return [
    { client: "claude", dir: clientSkillRoots.claude(home), nested: false },
    { client: "codex", dir: clientSkillRoots.codex(home), nested: true },
    { client: "gemini", dir: clientSkillRoots.gemini(home), nested: false },
    { client: "hermes", dir: clientSkillRoots.hermes(home), nested: true },
    {
      client: "agents",
      dir: path.join(home, ".agents", "skills"),
      nested: false,
    },
  ];
}

const indexPath = () => oceanPath(SYSTEM_DIR, "state", "skill-index.json");
const statePath = () => oceanPath(SYSTEM_DIR, "state", "skill-router.json");

// One frontmatter field, with folded (`>`), literal (`|`) and indented continuation lines.
export function frontmatterField(text: string, key: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) return "";
  const end = normalized.indexOf("\n---", 3);
  const lines = normalized.slice(3, end < 0 ? undefined : end).split("\n");
  const pattern = new RegExp(`^${key}:\\s*(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const match = pattern.exec(lines[i]);
    if (!match) continue;
    const first = match[1].trim();
    const parts = /^[>|][+-]?$/.test(first) ? [] : [first];
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++)
      parts.push(lines[j].trim());
    return parts
      .join(" ")
      .replace(/^["']|["']$/g, "")
      .trim();
  }
  return "";
}

// "Use when the user says start my day, good morning, or plan today." → the quoted-in-prose
// phrases; also anything in double quotes. Placeholders (`X`) are dropped.
export function triggerPhrases(description: string): string[] {
  const phrases = new Set<string>();
  const add = (raw: string) => {
    const phrase = normalizeText(raw)
      .replace(/^(?:or|and)\s+/, "")
      .replace(/\s+\b[xy]\b$/, "")
      .trim();
    const words = phrase.split(" ").filter(Boolean);
    if (phrase.length >= 4 && words.length <= 6 && words.some(isContentWord))
      phrases.add(phrase);
  };
  const lead =
    /\b(?:says?|mentions?|types?|asks? (?:for|to|about))\b:?\s+([^.]+?)(?:\.(?:\s|$)|$)/gi;
  for (const match of description.matchAll(lead))
    for (const part of match[1].split(/,|;/)) add(part);
  for (const match of description.matchAll(/["“]([^"”]{3,60})["”]/g))
    add(match[1]);
  return [...phrases];
}

async function scanRoot(
  root: Root,
  nested: boolean,
  found: Map<string, IndexedSkill>,
  off: Set<string>,
): Promise<void> {
  let entries: string[];
  try {
    entries = (await readdir(root.dir)).sort();
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(".") && !nested) continue;
    const file = path.join(root.dir, entry, "SKILL.md");
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      if (nested)
        await scanRoot(
          { ...root, dir: path.join(root.dir, entry) },
          false,
          found,
          off,
        );
      continue;
    }
    const name = frontmatterField(text, "name") || entry;
    if (off.has(name)) continue;
    if (/^true$/i.test(frontmatterField(text, "disable-model-invocation")))
      continue;
    const known = found.get(name);
    if (known) {
      known.files[root.client] ??= file;
      continue;
    }
    const description = frontmatterField(text, "description");
    if (!description) continue;
    found.set(name, {
      name,
      description,
      triggers: triggerPhrases(description),
      files: { [root.client]: file },
    });
  }
}

// Skills the owner switched fully off in Claude (`skillOverrides: off`) stay out of the index;
// hidden ones (`user-invocable-only`) are what the router is for.
async function claudeOffSkills(home: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(home, ".claude", "settings.json"), "utf8"),
    );
    const overrides = parsed?.skillOverrides;
    if (!overrides || typeof overrides !== "object") return new Set();
    return new Set(
      Object.entries(overrides)
        .filter(([, value]) => value === "off")
        .map(([name]) => name),
    );
  } catch {
    return new Set();
  }
}

// Rebuilt by the session-start skill sync and whenever a skills root changed since.
export async function buildSkillIndex(
  home = os.homedir(),
  write = true,
): Promise<SkillIndex> {
  const off = await claudeOffSkills(home);
  const found = new Map<string, IndexedSkill>();
  for (const root of skillRoots(home))
    await scanRoot(root, root.nested, found, off);
  const index: SkillIndex = {
    version: 1,
    builtAt: Date.now(),
    skills: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
  if (write) {
    await mkdir(path.dirname(indexPath()), { recursive: true });
    await atomicWrite(indexPath(), `${JSON.stringify(index)}\n`);
  }
  return index;
}

// The cached index, rebuilt when missing or older than a skills root (a skill added or removed).
export async function loadSkillIndex(home = os.homedir()): Promise<SkillIndex> {
  let cached: SkillIndex | null = null;
  try {
    const parsed = JSON.parse(await readFile(indexPath(), "utf8"));
    if (parsed?.version === 1 && Array.isArray(parsed.skills)) cached = parsed;
  } catch {}
  if (cached) {
    let newest = 0;
    for (const root of skillRoots(home)) {
      const info = await stat(root.dir).catch(() => null);
      if (info) newest = Math.max(newest, info.mtimeMs);
    }
    if (newest <= cached.builtAt) return cached;
  }
  return buildSkillIndex(home);
}

// Message shapes that carry intent no single word does: "Zustand or Redux?" is a comparison.
function expansions(message: string): string[] {
  const words: string[] = [];
  const text = message.trim();
  if (
    /\b(?:vs\.?|versus|better than|difference between|which is better|pros and cons)\b/i.test(
      text,
    ) ||
    /^[^\n?]{1,60}\s+or\s+[^\n?]{1,60}\?\s*$/i.test(text)
  )
    words.push("compare");
  return words;
}

type Prepared = {
  skill: IndexedSkill;
  name: Set<string>;
  tf: Map<string, number>;
  length: number;
};

// Whether the working directory points at this skill: a file named like it, or a dependency
// named like it (or like its first word: `next` → next-best-practices).
function projectHit(name: string, signals: Set<string>): boolean {
  const lower = name.toLowerCase();
  const head = lower.split("-")[0];
  return (
    signals.has(lower) ||
    signals.has(`dep:${lower}`) ||
    (head.length >= 4 && signals.has(`dep:${head}`))
  );
}

const PREFERRED_ROOT: Record<string, string[]> = {
  claude: ["claude"],
  codex: ["codex", "agents"],
  gemini: ["gemini", "agents"],
  hermes: ["hermes"],
  qwen: ["agents"],
};

function fileFor(skill: IndexedSkill, client: string): string {
  for (const root of PREFERRED_ROOT[client] ?? [])
    if (skill.files[root]) return skill.files[root];
  return Object.values(skill.files)[0] ?? "";
}

// BM25 over each description (the name counts double), plus trigger-phrase hits and the
// working-directory signal. Pure: the same index, message and signals give the same answer.
export function routeSkills(
  index: SkillIndex,
  message: string,
  options: { signals?: Set<string>; client?: string; limit?: number } = {},
): { matches: SkillMatch[]; candidates: SkillMatch[] } {
  const empty = { matches: [], candidates: [] };
  const text = message.slice(0, MESSAGE_CHARS);
  if (!text.trim() || text.trimStart().startsWith("/")) return empty;
  const extra = expansions(text);
  const query = [...new Set([...tokenize(text), ...extra.map(stem)])];
  if (!query.length) return empty;
  const spoken = ` ${[normalizeText(text), ...extra].join(" ")} `;

  const prepared: Prepared[] = index.skills.map((skill) => {
    const name = new Set(tokenize(skill.name.replace(/[-_]/g, " ")));
    const tf = new Map<string, number>();
    const words = tokenize(skill.description);
    for (const word of words) tf.set(word, (tf.get(word) ?? 0) + 1);
    for (const word of name) tf.set(word, (tf.get(word) ?? 0) + 2);
    return { skill, name, tf, length: words.length + name.size * 2 };
  });
  const count = prepared.length || 1;
  const average =
    prepared.reduce((sum, item) => sum + item.length, 0) / count || 1;
  const df = new Map<string, number>();
  for (const item of prepared)
    for (const word of item.tf.keys()) df.set(word, (df.get(word) ?? 0) + 1);

  // IDF is scaled so a word unique to one skill weighs IDF_CEILING however many skills are
  // installed: the threshold then means the same with 15 skills or 150.
  const rarest = Math.log(1 + (count - 0.5) / 1.5) || 1;
  const k1 = 1.2;
  const b = 0.75;
  const signals = options.signals ?? new Set<string>();
  const scored: SkillMatch[] = [];
  for (const item of prepared) {
    let score = 0;
    const why: string[] = [];
    let words = 0;
    for (const word of query) {
      const tf = item.tf.get(word);
      if (!tf) continue;
      const seen = df.get(word) ?? 0;
      const idf =
        (Math.log(1 + (count - seen + 0.5) / (seen + 0.5)) / rarest) *
        IDF_CEILING;
      const norm = k1 * (1 - b + (b * item.length) / average);
      score += (idf * (tf * (k1 + 1))) / (tf + norm);
      words++;
      why.push(word);
    }
    let phrases = 0;
    for (const phrase of item.skill.triggers)
      if (spoken.includes(` ${phrase} `) && phrases < 2) {
        score += 4 + phrase.split(" ").length;
        phrases++;
        why.push(`"${phrase}"`);
      }
    // One shared word is a coincidence unless it is the skill's own name or a phrase it lists.
    const nameHit = query.some((word) => item.name.has(word));
    if (words < 2 && !phrases && !nameHit) continue;
    if (score > 0 && projectHit(item.skill.name, signals)) {
      score += 4;
      why.push("project");
    }
    if (score <= 0) continue;
    scored.push({
      name: item.skill.name,
      file: fileFor(item.skill, options.client ?? "claude"),
      score: Math.round(score * 10) / 10,
      why,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const candidates = scored.slice(0, options.limit ?? 5);
  const top = scored[0];
  if (!top || top.score < ROUTE_THRESHOLD) return { matches: [], candidates };
  // Close runners-up: one is named alongside the top skill; two or more mean the message is
  // generic ("write tests" with three test skills and nothing in the project to choose), so
  // nothing is named.
  const close = scored
    .slice(1)
    .filter((item) => item.score >= top.score * SECOND_RATIO);
  if (close.length >= 2) return { matches: [], candidates };
  const matches = [top, ...close];
  return { matches, candidates };
}

export function routerLine(matches: SkillMatch[]): string {
  if (matches.length === 1)
    return `Skill router: this request matches the "${matches[0].name}" skill. Read ${matches[0].file} and follow it if it fits.`;
  const list = matches.map((match) => `"${match.name}" (${match.file})`);
  return `Skill router: this request matches the skills ${list.join(" and ")}. Read the one that fits and follow it.`;
}

type RouterState = {
  // Skills already named in a session are not named again in it.
  sessions: Record<string, { at: number; skills: string[] }>;
  // How often each skill was named, for spotting weak or noisy triggers.
  hits: Record<string, number>;
};

async function readState(): Promise<RouterState> {
  try {
    const parsed = JSON.parse(await readFile(statePath(), "utf8"));
    return {
      sessions:
        parsed?.sessions && typeof parsed.sessions === "object"
          ? parsed.sessions
          : {},
      hits: parsed?.hits && typeof parsed.hits === "object" ? parsed.hits : {},
    };
  } catch {
    return { sessions: {}, hits: {} };
  }
}

const SESSION_TTL_MS = 3 * 24 * 60 * 60 * 1000;

const HOOK_EVENT: Record<string, string> = {
  claude: "UserPromptSubmit",
  codex: "UserPromptSubmit",
  qwen: "UserPromptSubmit",
  gemini: "BeforeAgent",
};

export const PROMPT_HOOK_CLIENTS = Object.keys(HOOK_EVENT);

// `ocean hook prompt --client <c>`: the hook payload in, the client's additional-context
// output (or nothing) out. Never throws on a bad payload: a prompt hook must not block a prompt.
export async function skillRouterHook(
  payload: Record<string, unknown>,
  client: string,
  home = os.homedir(),
): Promise<Record<string, unknown> | null> {
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  if (!prompt.trim()) return null;
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const session =
    typeof payload.session_id === "string" ? payload.session_id : "";
  const index = await loadSkillIndex(home);
  const { matches } = routeSkills(index, prompt, {
    signals: await projectSignals(cwd),
    client,
  });
  if (!matches.length) return null;
  const state = await readState();
  const seen = new Set(session ? (state.sessions[session]?.skills ?? []) : []);
  const fresh = matches.filter((match) => !seen.has(match.name));
  if (!fresh.length) return null;
  const now = Date.now();
  for (const [id, entry] of Object.entries(state.sessions))
    if (!entry || now - entry.at > SESSION_TTL_MS) delete state.sessions[id];
  if (session)
    state.sessions[session] = {
      at: now,
      skills: [...seen, ...fresh.map((match) => match.name)],
    };
  for (const match of fresh)
    state.hits[match.name] = (state.hits[match.name] ?? 0) + 1;
  try {
    await mkdir(path.dirname(statePath()), { recursive: true });
    await atomicWrite(statePath(), `${JSON.stringify(state, null, 2)}\n`);
  } catch {}
  return {
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT[client] ?? "UserPromptSubmit",
      additionalContext: routerLine(fresh),
    },
  };
}
