import os from "node:os";

// Pure secret/PII redaction. Lives in the domain layer because it is a set of
// string transforms with no I/O — application code redacts through here instead
// of importing the infrastructure logger.

const MAX_PAYLOAD = 64_000;
// Credential shapes: vendor prefixes, bearer tokens, JWTs, private keys, credentialed URLs.
// Every pattern stays linear on hostile input (bounded runs, anchored starts): these scan
// file contents a model asked for, and a backtracking pattern would hang the run.
const shapePatterns = [
  // \b: a prefix inside a word ("task-observer") is not a key.
  /\b(?:sk-(?:ant-)?|AIza|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8,}/gi,
  // AWS access key ids, Stripe, npm, GitLab and the other GitHub token prefixes.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bgh[ousr]_[A-Za-z0-9]{36,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----[\s\S]{0,16384}?-----END (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/g,
  // Connection strings and webhook URLs that embed a credential in the userinfo or path
  // segment, e.g. postgres://user:pass@host/db or a Slack incoming-webhook URL.
  /\b[a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/[^\s'"<>/:@]{1,256}:[^\s'"<>/@]{1,256}@[^\s'"<>]{1,256}/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/gi,
];
// Redaction also catches unquoted secret-named assignments; too broad to refuse a file on
// (it matches `password = input.value`), right for scrubbing logs.
const keywordAssignment =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi;
const secretPatterns = [...shapePatterns, keywordAssignment];
const homePath = os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const privatePathPattern = new RegExp(`${homePath}(?:[/\\\\][^\\s/'"]+)*`, "g");

// Fallback for credentials that don't match a known vendor prefix or keyword (a raw AWS
// secret access key, an internal hex/base32 API key, a bare high-entropy token): any long
// run of base64/hex-ish characters with entropy consistent with random data gets redacted,
// even without a recognizable shape. This is best-effort, not a guarantee — see docs/security.md.
const highEntropyToken = /[A-Za-z0-9+/_-]{24,}/g;
const MIN_TOKEN_ENTROPY_BITS_PER_CHAR = 3.5;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function redactHighEntropyTokens(value: string): string {
  return value.replace(highEntropyToken, (token) =>
    shannonEntropy(token) >= MIN_TOKEN_ENTROPY_BITS_PER_CHAR
      ? "[REDACTED]"
      : token,
  );
}

// Secret-named assignments, for refusing a file only (too broad for redaction): an env-style
// line such as DB_PASS=..., or a quoted literal assigned to a secret-named key. Matched one
// bounded line at a time with bounded runs, so a long or hostile line cannot backtrack.
const MAX_LINE = 4_096;
const assignedSecretPatterns = [
  /^[ \t]{0,16}(?:export[ \t]+)?[A-Z0-9_]{0,64}(?:PASS|PASSWORD|PASSWD|PWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY)[A-Z0-9_]{0,64}[ \t]{0,8}=[ \t]{0,8}\S{6}/,
  /(?:^|[^A-Za-z0-9_])["']?[A-Za-z0-9_]{0,64}(?:secret|token|passw(?:or)?d|pwd|api_?key)[A-Za-z0-9_]{0,64}["']?[ \t]{0,8}[:=][ \t]{0,8}["'][^"'\s]{8,256}["']/i,
];

function hasAssignedSecret(value: string): boolean {
  return value
    .split("\n")
    .some((line) =>
      assignedSecretPatterns.some((pattern) =>
        pattern.test(line.slice(0, MAX_LINE)),
      ),
    );
}

// Whether the text holds a credential of a known shape or a secret-named literal. No entropy
// guess and no bare keyword match: used to refuse sending a file, where a false positive on
// ordinary code would be costly. Pattern-based, so a secret in an unknown shape gets through.
export function containsKnownSecret(value: string): boolean {
  return (
    shapePatterns.some((pattern) => value.match(pattern) !== null) ||
    hasAssignedSecret(value)
  );
}

// Pattern replacement only, no length bound — for callers that need to persist a redacted
// payload of arbitrary size (e.g. `ocean observe`'s captured command output).
export function redactSecrets(value: string): string {
  let safe = value;
  for (const pattern of secretPatterns)
    safe = safe.replace(pattern, "[REDACTED]");
  safe = redactHighEntropyTokens(safe);
  return safe.replace(privatePathPattern, "[PRIVATE_PATH]");
}

export function redactRuntimeText(value: string): string {
  return redactSecrets(value).slice(0, MAX_PAYLOAD);
}
