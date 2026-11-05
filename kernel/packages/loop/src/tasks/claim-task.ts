import { readdir, readFile, writeFile } from "node:fs/promises";
import { localDate } from "@ocean/core/shared/local-date.js";
import { resolveWithin } from "@ocean/core/shared/paths.js";

// Keep equal to CLAIM_TTL_MS in scripts/validate-tasks.mjs (a test pins the two together).
export const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;

const OWNER = /^[\w.@/-]{1,64}$/;
const CLAIM_PATH = /^(?!\/)(?!.*\.\.)[\w.@/-]+$/;

export type Claim = { by: string; at: string; paths: string[] };
type ClaimInput = { by: string; paths?: string[]; force?: boolean; now?: Date };

const unquote = (value: string) => value.replace(/^['"]|['"]$/g, "");

function frontmatterFields(source: string): Record<string, string> {
  const end = source.indexOf("\n---", 4);
  if (!source.startsWith("---\n") || end < 0) return {};
  const fields: Record<string, string> = {};
  for (const line of source.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0 && /^[\w-]+$/.test(line.slice(0, separator)))
      fields[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  return fields;
}

function parseClaim(fields: Record<string, string>): Claim | null {
  if (!fields.claimed_by || !fields.claimed_at) return null;
  const list = fields.claimed_paths?.match(/^\[(.*)\]$/)?.[1] ?? "";
  return {
    by: unquote(fields.claimed_by),
    at: unquote(fields.claimed_at),
    paths: list
      .split(",")
      .map((entry) => normalizePath(unquote(entry.trim())))
      .filter(Boolean),
  };
}

const normalizePath = (value: string) =>
  value.replace(/^\.\//, "").replace(/\/+$/, "");
const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

export function isStale(claim: Claim, now = new Date()): boolean {
  const claimedAt = Date.parse(claim.at);
  return Number.isNaN(claimedAt) || now.getTime() - claimedAt > CLAIM_TTL_MS;
}

// Replace the claim lines in the frontmatter (and bump `updated`), keeping every other line.
function withClaim(source: string, claim: Claim | null, today: string): string {
  const end = source.indexOf("\n---", 4);
  const kept = source
    .slice(4, end)
    .split("\n")
    .filter((line) => !/^claimed_(by|at|paths):/.test(line))
    .map((line) => (/^updated:/.test(line) ? `updated: ${today}` : line));
  if (claim) {
    kept.push(`claimed_by: ${claim.by}`, `claimed_at: ${claim.at}`);
    if (claim.paths.length)
      kept.push(`claimed_paths: [${claim.paths.join(", ")}]`);
  }
  return `---\n${kept.join("\n")}${source.slice(end)}`;
}

async function liveClaimsElsewhere(root: string, id: string, now: Date) {
  const found: { id: string; claim: Claim }[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "archive" || entry.name === id)
      continue;
    const source = await readFile(
      resolveWithin(root, entry.name, "task.md"),
      "utf8",
    ).catch(() => "");
    const claim = parseClaim(frontmatterFields(source));
    if (claim && !isStale(claim, now)) found.push({ id: entry.name, claim });
  }
  return found;
}

/**
 * Record that `by` is working on a task. Refuses (throws, naming the holder) when another
 * owner holds a non-stale claim on it, or when `paths` overlap a non-stale claim another owner
 * holds on a different task. The same owner re-claiming refreshes the timestamp. Claims are
 * advisory: they make a collision visible, they do not lock the files.
 */
export async function claimTask(
  id: string,
  root: string,
  input: ClaimInput,
): Promise<{ claimed: string; by: string; at: string; tookOver?: string }> {
  if (!OWNER.test(input.by))
    throw new Error("--by must be 1-64 chars of letters, digits, . _ @ / -");
  const paths = (input.paths ?? []).map(normalizePath).filter(Boolean);
  for (const entry of paths)
    if (!CLAIM_PATH.test(entry))
      throw new Error(`Invalid claim path: ${entry}`);
  const now = input.now ?? new Date();
  const taskFile = resolveWithin(root, id, "task.md");
  const source = await readFile(taskFile, "utf8");
  const fields = frontmatterFields(source);
  if (["done", "cancelled"].includes(fields.state))
    throw new Error(`${id} is ${fields.state}; it cannot be claimed`);
  const held = parseClaim(fields);
  let tookOver: string | undefined;
  if (held && held.by !== input.by && !isStale(held, now)) {
    if (!input.force)
      throw new Error(
        `${id} is claimed by ${held.by} since ${held.at}. Ask the owner, wait for it to expire (2 h), or use --force.`,
      );
    tookOver = held.by;
  }
  if (!input.force)
    for (const other of await liveClaimsElsewhere(root, id, now)) {
      if (other.claim.by === input.by) continue;
      const clash = paths.find((mine) =>
        other.claim.paths.some((theirs) => overlaps(mine, theirs)),
      );
      if (clash)
        throw new Error(
          `${clash} overlaps ${other.claim.paths.join(", ")} claimed by ${other.claim.by} on ${other.id}.`,
        );
    }
  const claim: Claim = { by: input.by, at: now.toISOString(), paths };
  await writeFile(taskFile, withClaim(source, claim, localDate(now)), "utf8");
  // Read-modify-write is not atomic: if a concurrent claim landed between our read and write,
  // the file now names someone else. Re-read so the loser finds out instead of assuming it won.
  const written = parseClaim(
    frontmatterFields(await readFile(taskFile, "utf8")),
  );
  if (written?.by !== input.by)
    throw new Error(`${id} was claimed by ${written?.by} at the same time.`);
  return { claimed: id, by: claim.by, at: claim.at, tookOver };
}

/**
 * Drop a task's claim. Only the owner may release a live claim (or `force`); a stale claim can
 * be released by anyone. Returns `released: false` when there was nothing to release.
 */
export async function releaseTask(
  id: string,
  root: string,
  input: { by?: string; force?: boolean; now?: Date },
): Promise<{ released: boolean; id: string; was?: string }> {
  const now = input.now ?? new Date();
  const taskFile = resolveWithin(root, id, "task.md");
  const source = await readFile(taskFile, "utf8");
  const held = parseClaim(frontmatterFields(source));
  if (!held) return { released: false, id };
  if (held.by !== input.by && !isStale(held, now) && !input.force)
    throw new Error(
      `${id} is claimed by ${held.by}; only that owner can release it (or use --force).`,
    );
  await writeFile(taskFile, withClaim(source, null, localDate(now)), "utf8");
  return { released: true, id, was: held.by };
}
