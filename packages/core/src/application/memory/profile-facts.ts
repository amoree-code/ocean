import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { assertProfileName } from "../../domain/profiles/profile.js";
import { atomicWrite, truncateUtf8, withFileLock } from "../../fs-utils.js";
import { oceanPath, resolveWithin, SYSTEM_DIR } from "../../paths.js";

const maxFacts = 100;
const maxFactBytes = 2_000;

export type ProfileFact = { key: string; value: string; updatedAt: string };

// The profile name is validated and the path is bounds-checked (including symlinks), so one
// profile's namespace can never resolve to another file inside or outside the memory root.
export function profileFactsFile(profile: string): string {
  return resolveWithin(
    oceanPath(SYSTEM_DIR, "memory", "profiles"),
    `${assertProfileName(profile)}.json`,
  );
}

export async function readProfileFacts(
  profile: string,
): Promise<ProfileFact[]> {
  try {
    const facts = JSON.parse(
      await readFile(profileFactsFile(profile), "utf8"),
    ) as ProfileFact[];
    return Array.isArray(facts) ? facts.slice(0, maxFacts) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

// Read-modify-write under the file lock, replaced atomically: concurrent writers to the same
// profile each see the other's facts, and a crash never leaves a truncated file. `change`
// returns null to skip the write.
async function updateProfileFacts(
  profile: string,
  change: (facts: ProfileFact[]) => ProfileFact[] | null,
): Promise<void> {
  const file = profileFactsFile(profile);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await withFileLock(file, async () => {
    const next = change(await readProfileFacts(profile));
    if (next)
      await atomicWrite(
        file,
        `${JSON.stringify(next.slice(0, maxFacts), null, 2)}\n`,
        0o600,
      );
  });
}

export async function writeProfileFact(
  profile: string,
  key: string,
  value: string,
): Promise<ProfileFact> {
  if (!/^[a-zA-Z0-9._-]+$/.test(key))
    throw new Error(
      "Fact key must contain only letters, numbers, dot, underscore, or hyphen",
    );
  if (!value.trim() || Buffer.byteLength(value) > maxFactBytes)
    throw new Error("Fact value is empty or exceeds 2000 bytes");
  const fact = {
    key,
    value: value.trim(),
    updatedAt: new Date().toISOString(),
  };
  await updateProfileFacts(profile, (facts) => [
    fact,
    ...facts.filter((item) => item.key !== key),
  ]);
  return fact;
}

export async function deleteProfileFact(
  profile: string,
  key: string,
): Promise<boolean> {
  let deleted = false;
  await updateProfileFacts(profile, (facts) => {
    const remaining = facts.filter((fact) => fact.key !== key);
    deleted = remaining.length !== facts.length;
    return deleted ? remaining : null;
  });
  return deleted;
}

export const PROFILE_FACTS_DIGEST_MAX_BYTES = 2_048;

// A bounded digest of the profile's durable facts for a headless prompt: newest first (by
// updatedAt, since hand-edited files may not be ordered), whole `- key: value` lines while
// they fit, and always a pointer to the full set. The whole section stays <= maxBytes; if
// not even the newest fact fits, it is byte-truncated so at least one fact is visible.
// `partial` says whether it left anything out (a dropped or byte-truncated fact), in which
// case the provider must be able to follow the pointer to the store file.
export function buildProfileFactsDigest(
  profile: string,
  facts: ProfileFact[],
  maxBytes = PROFILE_FACTS_DIGEST_MAX_BYTES,
): { text: string; partial: boolean } {
  if (!facts.length) return { text: "", partial: false };
  const time = (fact: ProfileFact) => {
    const value = Date.parse(fact.updatedAt);
    return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
  };
  const ordered = [...facts].sort((a, b) => time(b) - time(a));
  const heading = "## Durable profile facts";
  const pointer = (shown: number) =>
    `(${shown} of ${facts.length} facts, newest first; full set: ocean memory facts ${profile} or ${profileFactsFile(profile)})`;
  // Reserve the pointer's worst case (shown === total) so its size never grows past the budget.
  const reserved = Buffer.byteLength(pointer(facts.length)) + 1;
  const lines: string[] = [];
  let used = Buffer.byteLength(heading);
  let whole = 0;
  for (const fact of ordered) {
    const line = `- ${fact.key}: ${String(fact.value).replace(/\s+/g, " ").trim()}`;
    const cost = Buffer.byteLength(line) + 1;
    if (used + cost + reserved <= maxBytes) {
      lines.push(line);
      used += cost;
      whole += 1;
      continue;
    }
    if (!lines.length) {
      const room = maxBytes - used - reserved - 1 - Buffer.byteLength("...");
      lines.push(`${truncateUtf8(line, Math.max(0, room))}...`);
    }
    break;
  }
  return {
    text: [heading, ...lines, pointer(lines.length)].join("\n"),
    partial: whole < facts.length,
  };
}
