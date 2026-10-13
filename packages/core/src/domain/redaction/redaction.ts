import os from "node:os";

// Pure secret/PII redaction. Lives in the domain layer because it is a set of
// string transforms with no I/O — application code redacts through here instead
// of importing the infrastructure logger.

const MAX_PAYLOAD = 64_000;
const secretPatterns = [
  /(?:sk-(?:ant-)?|AIza|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8,}/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/g,
  // Connection strings and webhook URLs that embed a credential in the userinfo or path
  // segment, e.g. postgres://user:pass@host/db or a Slack incoming-webhook URL.
  /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"<>]+:[^\s'"<>@]+@[^\s'"<>]+/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/gi,
];
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

// Whether the text holds a credential of a known shape (vendor prefixes, bearer tokens,
// key=value secrets, JWTs, private keys, credentialed URLs). No entropy guess: used to refuse
// sending a file, where a false positive on ordinary code would be costly.
export function containsKnownSecret(value: string): boolean {
  return secretPatterns.some((pattern) => value.match(pattern) !== null);
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
