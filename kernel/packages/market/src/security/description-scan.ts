// Text a capability puts in front of a model (skill bodies, tool and server descriptions) is
// instructions. Skills legitimately say "you must"; these rules only flag what an honest
// capability has no reason to contain.
export type ScanFinding = { source: string; rule: string; excerpt: string };

const rules: { rule: string; pattern: RegExp }[] = [
  {
    rule: "override-instructions",
    pattern:
      /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|system|all)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|messages?)\b/i,
  },
  {
    rule: "conceal-from-user",
    pattern:
      /\b(do not|don't|never)\b[^.\n]{0,30}\b(tell|inform|mention|reveal|show|notify)\b[^.\n]{0,30}\b(the )?(user|owner|human)\b/i,
  },
  {
    rule: "exfiltrate-secrets",
    pattern:
      /\b(send|post|upload|forward|exfiltrate|transmit)\b[^.\n]{0,60}\b(secrets?|tokens?|api[ _-]?keys?|passwords?|credentials?|ssh keys?|\.env)\b/i,
  },
  {
    rule: "read-secrets",
    pattern: /(~\/\.ssh\/|id_rsa|id_ed25519|\.aws\/credentials|\/\.env\b)/i,
  },
  {
    rule: "fake-system-tag",
    pattern: /<\s*\/?\s*(system|important|instructions?|admin)\s*>/i,
  },
  {
    // Zero-width, bidi-override and Unicode tag characters hide text from a human reviewer.
    rule: "hidden-unicode",
    pattern: /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/u,
  },
];

export function scanText(source: string, text: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const { rule, pattern } of rules) {
    const match = pattern.exec(text);
    if (!match) continue;
    const start = Math.max(0, match.index - 20);
    const excerpt = text
      .slice(start, match.index + match[0].length + 20)
      .replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, "␣")
      .replace(/[\u{E0000}-\u{E007F}]/gu, "␣")
      .replace(/\s+/g, " ")
      .trim();
    findings.push({ source, rule, excerpt });
  }
  return findings;
}
