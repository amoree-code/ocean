// One project goes by many names: its id, its display name, the Claude project it is in, the
// folder it used to live in (T-332). These are the deterministic comparisons between them. An
// exact or normalized match binds; a near one only ever suggests.

// Case, outer and repeated whitespace, and the separators people put between words (` - `, `|`,
// `_`, `.`, space) carry no meaning: `Jira - KarWatt`, `jira_karwatt` and `Jira KarWatt` are one.
export function normalizeName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s|_.-]+/g, " ")
    .trim();
}

// Edit distance with adjacent transpositions (optimal string alignment): `Desginer` is one edit
// from `designer`, not two.
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i < rows; i++)
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

const singular = (normalized: string) =>
  normalized
    .split(" ")
    .map((word) =>
      word.length > 3
        ? word.replace(/ies$/, "y").replace(/([^s])s$/, "$1")
        : word,
    )
    .join(" ");

// Two names that are probably the same thing but not equal once normalized: one or two edits
// apart (both long enough that this is not noise), singular against plural, or the same letters
// with the separators dropped (`star people` / `starpeople`). For suggestions only.
export function nearName(a: string, b: string): boolean {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right || left === right) return false;
  if (singular(left) === singular(right)) return true;
  if (left.replace(/ /g, "") === right.replace(/ /g, "")) return true;
  return (
    Math.min(left.length, right.length) >= 5 &&
    Math.abs(left.length - right.length) <= 2 &&
    editDistance(left, right) <= 2
  );
}

// Words that turn up in the owner's project names. A word one or two edits from one of these,
// and not itself one of them, is reported as a probable typo.
const KNOWN_WORDS = [
  "backend",
  "certificates",
  "company",
  "courses",
  "dashboard",
  "designer",
  "developer",
  "education",
  "frontend",
  "generator",
  "javascript",
  "marketing",
  "roadmap",
  "scanner",
  "studying",
  "typescript",
  "website",
  "workspace",
];

// The probable typos in a name: [written, meant] pairs.
export function nameTypos(name: string): Array<[string, string]> {
  const typos: Array<[string, string]> = [];
  for (const word of normalizeName(name).split(" ")) {
    if (word.length < 5 || KNOWN_WORDS.includes(word)) continue;
    if (KNOWN_WORDS.some((known) => singular(known) === singular(word)))
      continue;
    const meant = KNOWN_WORDS.find(
      (known) =>
        Math.abs(known.length - word.length) <= 2 &&
        editDistance(word, known) <= 2,
    );
    if (meant) typos.push([word, meant]);
  }
  return typos;
}
