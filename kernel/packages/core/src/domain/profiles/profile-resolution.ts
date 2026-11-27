import { tokenize } from "../../shared/text-tokens.js";

// One resolver for every profile choice (T-338 P2, plan §3.2): `ocean run` for a task, and a
// session start from its project and repository. No model call, and the same inputs always
// give the same answer.
//
// The primary profile is fixed for a session: the project's own `profiles` list, else the
// task, else the repository's signals, else `base`. Prompt text never changes the primary; a
// strong trigger match only adds a secondary profile whose skills may be suggested.

export type ProfileCandidate = {
  name: string;
  triggers?: string[];
  signals?: string[];
};

export type TaskSignals = {
  id: string;
  title: string;
  kind?: string;
  class?: string;
  risk?: string;
  objective?: string;
};

export type ResolveProfileInput = {
  // The profiles that are installed. Only these are ever returned (base aside).
  profiles: ProfileCandidate[];
  // `project.json` `profiles`, first one primary.
  projectProfiles?: string[];
  // Words the repository names, as projectSignals() gives them (`dep:react`, `dockerfile`).
  signals?: Iterable<string>;
  task?: TaskSignals;
  prompt?: string;
};

export type ProfileConfidence = "high" | "medium" | "low" | "none";

export type ProfileResolution = {
  primary: string;
  secondary: string[];
  confidence: ProfileConfidence;
  why: string[];
};

export const BASE_PROFILE = "base";
const MAX_SECONDARY = 2;
const MAX_TEXT = 2_000;

// The profiles before v3 (T-296) and the ones that replace them. An old name still answers for
// its new one and the other way round, so `ocean run` keeps working whichever set is installed;
// a profile is chosen by name only, so its identity (and a session's resume) never changes.
export const PROFILE_ALIASES: Record<string, string[]> = {
  base: ["default"],
  security: ["security-auditor"],
  "code-review": ["reviewer"],
  "qa-testing": ["tester"],
  analysis: ["researcher"],
  "product-strategy": ["strategist"],
  frontend: ["developer"],
  backend: ["developer"],
};

// The words the old rule table (PROFILE_RULES) matched, as triggers for a profile that declares
// none. Listed in the old table's order: on a tie the earlier one wins, as the first rule did.
const LEGACY_TRIGGERS: [string, string[]][] = [
  [
    "security",
    [
      "security",
      "privacy",
      "secret",
      "vulnerability",
      "vulnerable",
      "auth",
      "authentication",
      "authorization",
      "permission",
      "leak",
    ],
  ],
  ["code-review", ["review", "reviewer", "audit", "inspect", "inspection"]],
  [
    "qa-testing",
    [
      "test",
      "testing",
      "regression",
      "reproduce",
      "reproduction",
      "flaky",
      "coverage",
    ],
  ],
  [
    "devops",
    [
      "deploy",
      "deployment",
      "release",
      "ci",
      "pipeline",
      "docker",
      "dockerfile",
      "infra",
      "infrastructure",
      "runtime",
      "rollout",
    ],
  ],
  [
    "analysis",
    [
      "research",
      "investigate",
      "investigation",
      "compare",
      "comparison",
      "evaluate",
      "evaluation",
      "spike",
      "explore",
      "exploration",
    ],
  ],
  [
    "product-strategy",
    [
      "plan",
      "planning",
      "design",
      "architecture",
      "strategy",
      "roadmap",
      "proposal",
      "decide",
    ],
  ],
  [
    "developer",
    [
      "implement",
      "implementation",
      "fix",
      "build",
      "add",
      "feat",
      "feature",
      "bug",
      "refactor",
      "wire",
      "migrate",
      "migration",
    ],
  ],
];
const LEGACY_ORDER = LEGACY_TRIGGERS.map(([name]) => name);

// The names the old rule table returned, in its order.
export const LEGACY_PROFILES = [
  "security-auditor",
  "reviewer",
  "tester",
  "devops",
  "researcher",
  "strategist",
  "developer",
];

// The canonical name a profile answers for (`tester` → `qa-testing`), itself when it has none.
function canonical(name: string): string {
  for (const [target, olds] of Object.entries(PROFILE_ALIASES))
    if (olds.includes(name)) return target;
  return name;
}

function legacyTriggers(name: string): string[] {
  const own = canonical(name);
  const key = own === "frontend" || own === "backend" ? "developer" : own;
  return (
    LEGACY_TRIGGERS.find(
      ([legacy]) => legacy === key || legacy === name,
    )?.[1] ?? []
  );
}

// Old-table order first, so a tie goes where the first matching rule used to send it.
function rank(name: string): number {
  const own = canonical(name);
  const key = own === "frontend" || own === "backend" ? "developer" : own;
  const at = LEGACY_ORDER.indexOf(key);
  return at === -1 ? LEGACY_ORDER.length : at;
}

type Prepared = {
  name: string;
  triggers: string[][];
  signals: Set<string>;
};

// `components.json` → `components`, `Dockerfile` → `dockerfile`, `dep:React` → `dep:react`:
// the same shape projectSignals() gives a repository's file names and dependencies.
function signalTerm(signal: string): string {
  const lower = signal.trim().toLowerCase();
  if (lower.startsWith("dep:")) return lower;
  return lower.replace(/^\.+/, "").split(/[./\-_]/)[0] ?? "";
}

function prepare(profile: ProfileCandidate): Prepared {
  const declared = (profile.triggers ?? []).filter(Boolean);
  const words = declared.length ? declared : legacyTriggers(profile.name);
  return {
    name: profile.name,
    triggers: words
      .map((trigger) => tokenize(trigger))
      .filter((tokens) => tokens.length > 0),
    signals: new Set(
      (profile.signals ?? []).map(signalTerm).filter((term) => term.length),
    ),
  };
}

type Score = { name: string; score: number; phrase: boolean; hits: string[] };

// A trigger matches when every one of its words is in the text; a phrase (two words or more)
// counts as a strong match on its own.
function scoreText(profiles: Prepared[], text: string): Score[] {
  const words = new Set(tokenize(text.slice(0, MAX_TEXT)));
  if (!words.size) return [];
  const scores: Score[] = [];
  for (const profile of profiles) {
    const hits = profile.triggers.filter((tokens) =>
      tokens.every((token) => words.has(token)),
    );
    if (hits.length)
      scores.push({
        name: profile.name,
        score: hits.length,
        phrase: hits.some((tokens) => tokens.length > 1),
        hits: hits.map((tokens) => tokens.join(" ")),
      });
  }
  return sortScores(scores);
}

function sortScores(scores: Score[]): Score[] {
  return scores.sort(
    (a, b) =>
      b.score - a.score ||
      rank(a.name) - rank(b.name) ||
      a.name.localeCompare(b.name),
  );
}

// The installed profile a wanted name means: itself, else the profile it is an alias of, else
// one of its aliases.
export function installedAs(
  name: string,
  installed: Set<string>,
): string | null {
  if (installed.has(name)) return name;
  // An old name may answer for more than one new profile (`developer` → frontend, backend).
  for (const [target, olds] of Object.entries(PROFILE_ALIASES))
    if (olds.includes(name) && installed.has(target)) return target;
  for (const old of PROFILE_ALIASES[name] ?? [])
    if (installed.has(old)) return old;
  return null;
}

function fallback(installed: Set<string>): string {
  return installedAs(BASE_PROFILE, installed) ?? BASE_PROFILE;
}

export function resolveProfile(input: ResolveProfileInput): ProfileResolution {
  const profiles = input.profiles.map(prepare);
  const installed = new Set(profiles.map((profile) => profile.name));
  const base = fallback(installed);
  const why: string[] = [];
  let primary: string | null = null;
  let confidence: ProfileConfidence = "none";
  const secondary: string[] = [];

  const declared = (input.projectProfiles ?? [])
    .map((name) => installedAs(name, installed))
    .filter((name): name is string => Boolean(name));
  if (declared.length) {
    primary = declared[0];
    confidence = "high";
    why.push(`project lists ${primary}`);
    for (const name of declared.slice(1))
      if (name !== primary && !secondary.includes(name)) secondary.push(name);
  }

  if (!primary && input.task) {
    const task = input.task;
    // The kind is a declared signal and is tried alone first; title and objective are prose.
    const byKind = task.kind ? scoreText(profiles, task.kind) : [];
    const byText = byKind.length
      ? []
      : scoreText(profiles, `${task.title} ${task.objective ?? ""}`);
    const best = byKind[0] ?? byText[0];
    if (best) {
      primary = best.name;
      confidence = byKind.length ? "high" : "medium";
      why.push(
        `${task.id} ${byKind.length ? "kind" : "text"} matches ${best.hits.join(", ")}`,
      );
    }
  }

  if (!primary && input.signals) {
    const repo = new Set(input.signals);
    const scores = sortScores(
      profiles
        .map((profile) => {
          const hits = [...profile.signals].filter((term) => repo.has(term));
          return {
            name: profile.name,
            score: hits.length,
            phrase: false,
            hits,
          };
        })
        .filter((score) => score.score > 0),
    );
    const best = scores[0];
    if (best) {
      primary = best.name;
      confidence = best.score >= 2 ? "medium" : "low";
      why.push(`repository has ${best.hits.join(", ")}`);
    }
  }

  if (!primary) {
    primary = base;
    why.push("nothing matched");
  }

  if (input.prompt)
    for (const score of scoreText(profiles, input.prompt)) {
      if (secondary.length >= MAX_SECONDARY) break;
      if (score.name === primary || secondary.includes(score.name)) continue;
      if (score.score < 2 && !score.phrase) continue;
      secondary.push(score.name);
      why.push(`prompt matches ${score.name}: ${score.hits.join(", ")}`);
    }

  return {
    primary,
    secondary: secondary.slice(0, MAX_SECONDARY),
    confidence,
    why,
  };
}
