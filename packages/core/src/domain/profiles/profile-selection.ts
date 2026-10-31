// Profile suggestion for a task (T-296 §3.10): a fixed rule table over the task record —
// its `kind`, title and objective, plus `class`/`risk` — picks one installed profile and says
// why. First matching rule wins; nothing matching, or a profile that is not installed, falls
// back to `default`. The suggestion never widens anything by itself: `ocean run` uses it only
// when runtime.json turns `autoProfile` on, and an explicit --profile always wins.

export type TaskSignals = {
  id: string;
  title: string;
  kind?: string;
  class?: string;
  risk?: string;
  objective?: string;
};

export type ProfileSuggestion = {
  profile: string;
  rule: string;
  reason: string;
};

export const PROFILE_RULES: { rule: string; profile: string; words: RegExp }[] =
  [
    {
      rule: "security",
      profile: "security-auditor",
      words:
        /\b(security|privacy|secrets?|vulnerab\w*|auth(entication|orization)?|permissions?|leaks?)\b/,
    },
    {
      rule: "review",
      profile: "reviewer",
      words: /\b(review\w*|audit\w*|inspect\w*)\b/,
    },
    {
      rule: "test",
      profile: "tester",
      words: /\b(tests?|testing|regressions?|reproduc\w*|flaky|coverage)\b/,
    },
    {
      rule: "delivery",
      profile: "devops",
      words:
        /\b(deploy\w*|release\w*|ci|pipelines?|docker\w*|infra\w*|runtime|rollout)\b/,
    },
    {
      rule: "research",
      profile: "researcher",
      words:
        /\b(research\w*|investigat\w*|compar\w*|evaluat\w*|spike|explor\w*)\b/,
    },
    {
      rule: "planning",
      profile: "strategist",
      words:
        /\b(plan|planning|design|architecture|strategy|roadmap|proposal|decide)\b/,
    },
    {
      rule: "implementation",
      profile: "developer",
      words:
        /\b(implement\w*|fix\w*|build\w*|add\w*|feat\w*|bugs?|refactor\w*|wire\w*|migrat\w*)\b/,
    },
  ];

export function suggestProfile(
  task: TaskSignals,
  installed: string[],
): ProfileSuggestion {
  // The kind is a declared signal and is tried alone first; title and objective are prose.
  const sources = [task.kind ?? "", `${task.title} ${task.objective ?? ""}`];
  let match: (typeof PROFILE_RULES)[number] | undefined;
  for (const text of sources) {
    const lower = text.toLowerCase().slice(0, 2_000);
    match = PROFILE_RULES.find((rule) => rule.words.test(lower));
    if (match) break;
  }
  const highRisk = [task.class, task.risk].some(
    (value) => value?.toLowerCase() === "high",
  );
  const riskNote = highRisk ? "; high risk — verify before completing" : "";
  if (!match)
    return {
      profile: "default",
      rule: "fallback",
      reason: `no rule matched ${task.id}${riskNote}`,
    };
  if (!installed.includes(match.profile))
    return {
      profile: "default",
      rule: match.rule,
      reason: `${match.rule} work suggests ${match.profile}, which is not installed${riskNote}`,
    };
  return {
    profile: match.profile,
    rule: match.rule,
    reason: `${match.rule} work in ${task.id}${riskNote}`,
  };
}
