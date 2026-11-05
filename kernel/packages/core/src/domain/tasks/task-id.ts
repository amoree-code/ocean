// Task identifiers: <PREFIX>-<number> (T-256). Pure — no I/O. Every place that used to hard-code
// `T-\d+` goes through here, so the legacy `T` namespace and per-project prefixes (OL-001) are
// one rule.

// The namespace every task had before prefixes existed; it stays valid forever.
export const LEGACY_PREFIX = "T";

export const PREFIX_SHAPE = /^[A-Z][A-Z0-9]{0,5}$/;
export const TASK_ID = /^[A-Z][A-Z0-9]{0,5}-\d{1,6}$/;

// Real-world tokens shaped like an id ("UTF-8", "SHA-256", "ISO-8601", "GPT-5"): a project
// may never claim one, or free text would turn every mention into a task reference.
export const RESERVED_PREFIXES: readonly string[] = [
  "CVE",
  "GPT",
  "HTTP",
  "ISO",
  "PR",
  "RFC",
  "SHA",
  "TLS",
  "UTF",
];

export type ParsedTaskId = { prefix: string; number: number };

export function isValidPrefix(value: string): boolean {
  return PREFIX_SHAPE.test(value) && !RESERVED_PREFIXES.includes(value);
}

// Case-insensitive on input (`t-45`, `ol-1`), canonical upper-case prefix on output.
export function parseTaskId(value: string): ParsedTaskId | null {
  const match = /^([A-Za-z][A-Za-z0-9]{0,5})-(\d{1,6})$/.exec(value);
  if (!match) return null;
  return { prefix: match[1].toUpperCase(), number: Number(match[2]) };
}

export function formatTaskId(prefix: string, number: number): string {
  return `${prefix}-${String(number).padStart(3, "0")}`;
}

// A task folder may be spelled T-3 or T-003; both name the same task.
export function taskIdSpellings(id: string): string[] {
  const parsed = parseTaskId(id);
  if (!parsed) return [id];
  return [
    ...new Set([
      id,
      formatTaskId(parsed.prefix, parsed.number),
      `${parsed.prefix}-${parsed.number}`,
    ]),
  ];
}

// Ids mentioned in free text. `T-<n>` stays case-insensitive as it always was; any other prefix
// matches only when registered and written upper-case, so "utf-8" or "sha-256" never match.
export function extractTaskIds(
  text: string,
  prefixes: readonly string[] = [LEGACY_PREFIX],
): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(/\bT-(\d+)\b/gi))
    ids.add(`${LEGACY_PREFIX}-${match[1]}`);
  // Filtered to [A-Z0-9] by isValidPrefix, so joining into a pattern needs no escaping.
  const others = [...new Set(prefixes)].filter(
    (prefix) => prefix !== LEGACY_PREFIX && isValidPrefix(prefix),
  );
  if (others.length)
    for (const match of text.matchAll(
      new RegExp(`\\b(${others.join("|")})-(\\d+)\\b`, "g"),
    ))
      ids.add(`${match[1]}-${match[2]}`);
  return [...ids];
}

// A short prefix from a project id: initials of a multi-part id (ocean-language -> OL), else the
// first three letters (dashboard -> DAS). Taken or reserved candidates get a numeric suffix.
export function derivePrefix(
  projectId: string,
  taken: Iterable<string> = [],
): string {
  const used = new Set(
    [...taken, LEGACY_PREFIX].map((prefix) => prefix.toUpperCase()),
  );
  const segments = projectId
    .toUpperCase()
    .split(/[-._]/)
    .map((segment) => segment.replace(/[^A-Z0-9]/g, "").replace(/^[0-9]+/, ""))
    .filter(Boolean);
  const base =
    segments.length > 1
      ? segments
          .map((segment) => segment[0])
          .join("")
          .slice(0, 6)
      : (segments[0] ?? "P").slice(0, 3);
  const free = (candidate: string) =>
    isValidPrefix(candidate) && !used.has(candidate);
  if (free(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const tail = String(suffix);
    const candidate = `${base.slice(0, 6 - tail.length)}${tail}`;
    if (free(candidate)) return candidate;
  }
}
