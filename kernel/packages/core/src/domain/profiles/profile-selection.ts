import {
  BASE_PROFILE,
  installedAs,
  LEGACY_PROFILES,
  type ProfileCandidate,
  resolveProfile,
  type TaskSignals,
} from "./profile-resolution.js";

// Profile suggestion for a task (T-296 §3.10), now one call of resolveProfile() (T-338 P2):
// the task's `kind` first, then its title and objective, scored against each profile's
// triggers (a profile that declares none keeps the old rule table's words). Nothing matching,
// or a profile that is not installed, falls back to `base` (`default` before v3). The
// suggestion never widens anything by itself: `ocean run` uses it only when runtime.json turns
// `autoProfile` on, and an explicit --profile always wins.

export type { TaskSignals };

export type ProfileSuggestion = {
  profile: string;
  rule: string;
  reason: string;
};

function fallbackName(installed: Set<string>): string {
  return installed.has(BASE_PROFILE) ? BASE_PROFILE : "default";
}

export function suggestProfile(
  task: TaskSignals,
  installed: (string | ProfileCandidate)[],
): ProfileSuggestion {
  const candidates = installed.map((entry) =>
    typeof entry === "string" ? { name: entry } : entry,
  );
  const names = new Set(candidates.map((candidate) => candidate.name));
  // The old profiles that are not installed still compete, so the reason can say which one the
  // work wanted.
  const missing = LEGACY_PROFILES.filter((name) => !installedAs(name, names));
  const result = resolveProfile({
    profiles: [...candidates, ...missing.map((name) => ({ name }))],
    task,
  });
  const highRisk = [task.class, task.risk].some(
    (value) => value?.toLowerCase() === "high",
  );
  const riskNote = highRisk ? "; high risk — verify before completing" : "";
  const why = result.why[0] ?? "";
  if (result.confidence === "none")
    return {
      profile: fallbackName(names),
      rule: "fallback",
      reason: `no rule matched ${task.id}${riskNote}`,
    };
  if (!names.has(result.primary))
    return {
      profile: fallbackName(names),
      rule: result.primary,
      reason: `${why} — suggests ${result.primary}, which is not installed${riskNote}`,
    };
  return {
    profile: result.primary,
    rule: result.primary,
    reason: `${why}${riskNote}`,
  };
}
