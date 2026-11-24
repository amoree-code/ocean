// The weekly digest's "## Patterns" (T-329 phase 5): counts, not prose — where the week went
// (project, client), how it ended (status), what kept coming back (tasks, failures) and what it
// left open. Deterministic: no model reads anything here.

export type PatternSession = {
  text: string;
  title: string;
  status: string;
  project: string;
  provider: string;
  // True when the record has no title of its own (it fell back to the project or file name).
  untitled: boolean;
};

export type WeekFailure = { label: string; sessions: number };

const TOP = 5;

function tally(values: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const joined = (entries: [string, number][]) =>
  entries
    .slice(0, TOP)
    .map(([name, count]) => `${name} ${count}`)
    .join(" · ") +
  (entries.length > TOP ? ` · +${entries.length - TOP} more` : "");

export function weeklyPatterns(
  sessions: PatternSession[],
  failures: WeekFailure[] = [],
): string[] {
  if (!sessions.length) return [];
  const total = sessions.length;
  const lines = [
    `- Projects: ${joined(tally(sessions.map((item) => item.project || "none")))}`,
    `- Clients: ${joined(tally(sessions.map((item) => item.provider || "unknown")))}`,
    `- Status: ${joined(tally(sessions.map((item) => item.status || "unknown")))}`,
  ];
  const untitled = sessions.filter((item) => item.untitled).length;
  if (untitled)
    lines.push(
      `- Untitled: ${untitled} of ${total} (${Math.round((untitled / total) * 100)}%)`,
    );
  // A task counts once per session that names it; only one named in two or more is a pattern.
  const tasks = tally(
    sessions.flatMap((item) => [
      ...new Set(item.text.match(/\bT-\d{1,4}\b/g) ?? []),
    ]),
  ).filter(([, count]) => count >= 2);
  if (tasks.length) lines.push(`- Tasks across sessions: ${joined(tasks)}`);
  const repeated = failures
    .filter((item) => item.sessions >= 2)
    .sort((a, b) => b.sessions - a.sessions || a.label.localeCompare(b.label));
  if (repeated.length)
    lines.push(
      `- Repeated failures: ${joined(repeated.map((item) => [item.label, item.sessions]))}`,
    );
  const open = sessions.filter((item) =>
    /\n## Next\n\n\s*\S/.test(item.text),
  ).length;
  if (open) lines.push(`- Left a next step: ${open} of ${total}`);
  return lines;
}
