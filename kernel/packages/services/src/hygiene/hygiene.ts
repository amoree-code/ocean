import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  appendAudit,
  readAudit,
  sha256,
} from "@ocean/brain/memory/memory-audit.js";
import { atomicWrite, parseFrontmatter } from "@ocean/core/shared/fs-utils.js";
import {
  DAILY_DIR,
  KNOWLEDGE_DIR,
  oceanPath,
  PERSONAL_DIR,
  PROJECTS_DIR,
  SYSTEM_DIR,
} from "@ocean/core/shared/paths.js";
import { setFrontmatterFields } from "@ocean/loop/tasks/task-verification.js";

// Memory hygiene (T-322, COG C1) and record drift (forge F6), both deterministic.
//
// Hygiene re-checks the environment claims a record makes — a path exists, a URL answers, a
// GitHub repo resolves — then stamps `last_verified` (all hold) and a word `confidence`
// (high / low), and lists drifted records as proposed for archive. It never deletes and never
// overwrites a numeric confidence (lessons and extracted facts own those). Every stamp is an
// audited write, so drift does not flag it. One report per month in 01-daily/hygiene/.
//
// Drift compares each record's hash with last night's snapshot and lists the ones that changed
// with no memory audit entry since then: edits that bypassed the audited write path.

export type ClaimKind = "path" | "url" | "repo";
export type Claim = { kind: ClaimKind; value: string };
export type ClaimCheck = "ok" | "missing" | "unknown";
export type Checker = (claim: Claim) => Promise<ClaimCheck>;

export type RecordVerdict = {
  path: string;
  verdict: "verified" | "drifted" | "unverifiable";
  failing: Claim[];
};

export type HygieneCounts = {
  month: string;
  records: number;
  verified: number;
  drifted: number;
  unverifiable: number;
};

const SKIP_HOSTS =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|example\.(com|org|net)|[^/]*\.(local|test|example|invalid))$/i;
const PLACEHOLDER = /[<>*{}$|]|\.\.\./;
// An absolute path is a claim only under a real filesystem root; `/auth/refresh` is an API route.
const FS_ROOTS =
  /^\/(Users|home|opt|etc|usr|var|tmp|private|Library|Applications|Volumes|System|mnt|srv|root)\//;

// Workspace-relative markdown records that state facts: personal, professional, knowledge, and
// each project's memory/ and docs/. Archives are excluded.
export async function hygieneRecords(): Promise<string[]> {
  const root = oceanPath();
  const found: string[] = [];
  const walk = async (dir: string, keep: (rel: string) => boolean) => {
    const entries = await readdir(path.join(root, dir), {
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of entries) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "archive" && !entry.name.startsWith("."))
          await walk(rel, keep);
      } else if (entry.name.endsWith(".md") && keep(rel)) found.push(rel);
    }
  };
  for (const dir of [PERSONAL_DIR, "03-professional", KNOWLEDGE_DIR])
    await walk(dir, () => true);
  await walk(PROJECTS_DIR, (rel) => /\/(memory|docs)\//.test(rel));
  return found.sort();
}

export function extractClaims(text: string): Claim[] {
  const claims = new Map<string, Claim>();
  const add = (claim: Claim) =>
    claims.set(`${claim.kind}:${claim.value}`, claim);
  for (const [, raw] of text.matchAll(/`((?:~|\/)[^`\s]+)`/g)) {
    if (PLACEHOLDER.test(raw) || !raw.replace(/^~?\//, "").includes("/"))
      continue;
    if (raw.startsWith("/") && !FS_ROOTS.test(raw)) continue;
    add({ kind: "path", value: raw.replace(/[.,;:]+$/, "") });
  }
  for (const [raw] of text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) {
    const url = raw.replace(/[.,;:!?]+$/, "");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (SKIP_HOSTS.test(parsed.hostname) || PLACEHOLDER.test(url)) continue;
    if (parsed.hostname === "github.com") {
      const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
      if (owner && repo)
        add({ kind: "repo", value: `${owner}/${repo.replace(/\.git$/, "")}` });
      continue;
    }
    add({ kind: "url", value: url });
  }
  return [...claims.values()];
}

export function verdictOf(checks: ClaimCheck[]): RecordVerdict["verdict"] {
  if (checks.includes("missing")) return "drifted";
  return checks.every((check) => check === "ok") ? "verified" : "unverifiable";
}

const isNumber = (value: string | undefined) =>
  value !== undefined && value !== "" && !Number.isNaN(Number(value));

// The stamp a record gets, or null when it gets none.
export function stampFor(
  source: string,
  verdict: RecordVerdict["verdict"],
  today: string,
): string | null {
  if (verdict === "unverifiable") return null;
  const fields = parseFrontmatter(source);
  if (!source.startsWith("---\n")) return null;
  const change: Record<string, string> = {};
  if (verdict === "verified") change.last_verified = today;
  if (!isNumber(fields.confidence))
    change.confidence = verdict === "verified" ? "high" : "low";
  const next = setFrontmatterFields(source, change);
  return next === source ? null : next;
}

export const hygieneFile = (month: string) =>
  oceanPath(DAILY_DIR, "hygiene", `${month}.md`);

export async function runHygiene(options: {
  today: string;
  apply: boolean;
  check: Checker;
}): Promise<{ counts: HygieneCounts; records: RecordVerdict[] }> {
  const root = oceanPath();
  const cache = new Map<string, Promise<ClaimCheck>>();
  const check = (claim: Claim) => {
    const key = `${claim.kind}:${claim.value}`;
    if (!cache.has(key))
      cache.set(
        key,
        options.check(claim).catch(() => "unknown"),
      );
    return cache.get(key) as Promise<ClaimCheck>;
  };
  const records: RecordVerdict[] = [];
  for (const rel of await hygieneRecords()) {
    const file = path.join(root, rel);
    const source = await readFile(file, "utf8");
    const claims = extractClaims(source);
    if (!claims.length) continue;
    const checks = await Promise.all(claims.map(check));
    const verdict = verdictOf(checks);
    records.push({
      path: rel,
      verdict,
      failing: claims.filter((_, index) => checks[index] === "missing"),
    });
    const stamped = options.apply
      ? stampFor(source, verdict, options.today)
      : null;
    if (stamped) {
      await atomicWrite(file, stamped);
      await appendAudit({
        action: "update",
        path: rel,
        source: "hygiene",
        beforeSha: sha256(source),
        afterSha: sha256(stamped),
      });
    }
  }
  const count = (verdict: RecordVerdict["verdict"]) =>
    records.filter((record) => record.verdict === verdict).length;
  return {
    counts: {
      month: options.today.slice(0, 7),
      records: records.length,
      verified: count("verified"),
      drifted: count("drifted"),
      unverifiable: count("unverifiable"),
    },
    records,
  };
}

// Every saved monthly report's counts, oldest first.
export async function readHygieneHistory(): Promise<HygieneCounts[]> {
  const dir = path.dirname(hygieneFile("x"));
  const history: HygieneCounts[] = [];
  for (const name of (await readdir(dir).catch(() => [] as string[])).sort()) {
    if (!/^\d{4}-\d{2}\.md$/.test(name)) continue;
    const fields = parseFrontmatter(
      await readFile(path.join(dir, name), "utf8"),
    );
    history.push({
      month: name.slice(0, 7),
      records: Number(fields.records) || 0,
      verified: Number(fields.verified) || 0,
      drifted: Number(fields.drifted) || 0,
      unverifiable: Number(fields.unverifiable) || 0,
    });
  }
  return history;
}

export function renderHygieneReport(
  counts: HygieneCounts,
  records: RecordVerdict[],
  earlier: HygieneCounts[],
): string {
  const trend = [
    ...earlier.filter((row) => row.month !== counts.month),
    counts,
  ];
  const drifted = records.filter((record) => record.verdict === "drifted");
  return [
    "---",
    "type: hygiene",
    `month: ${counts.month}`,
    `records: ${counts.records}`,
    `verified: ${counts.verified}`,
    `drifted: ${counts.drifted}`,
    `unverifiable: ${counts.unverifiable}`,
    "---",
    "",
    `# Memory hygiene — ${counts.month}`,
    "",
    `${counts.records} records make an environment claim: ${counts.verified} verified, ${counts.drifted} drifted, ${counts.unverifiable} unverifiable (a check could not answer).`,
    "",
    "## Drift trend",
    "",
    "| Month | Records | Verified | Drifted | Unverifiable |",
    "|---|---|---|---|---|",
    ...trend.map(
      (row) =>
        `| ${row.month} | ${row.records} | ${row.verified} | ${row.drifted} | ${row.unverifiable} |`,
    ),
    "",
    "## Proposed for archive (review; nothing was deleted)",
    "",
    ...(drifted.length
      ? drifted.map(
          (record) =>
            `- \`${record.path}\` — ${record.failing.map((claim) => `${claim.kind} \`${claim.value}\` missing`).join("; ")}`,
        )
      : ["None."]),
    "",
  ].join("\n");
}

export async function writeHygieneReport(
  month: string,
  text: string,
): Promise<string> {
  const file = hygieneFile(month);
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, text);
  return file;
}

// --- Drift (F6) -----------------------------------------------------------------------------

const snapshotFile = () => oceanPath(SYSTEM_DIR, "state", "record-hashes.json");
export const driftFile = () => oceanPath(SYSTEM_DIR, "state", "drift.json");

export type DriftResult = {
  at: string;
  since: string | null;
  records: number;
  unrecorded: string[];
};

export async function checkDrift(options: {
  apply: boolean;
  now?: Date;
}): Promise<DriftResult> {
  const now = (options.now ?? new Date()).toISOString();
  const root = oceanPath();
  const hashes: Record<string, string> = {};
  for (const rel of await hygieneRecords())
    hashes[rel] = sha256(await readFile(path.join(root, rel), "utf8"));
  const previous: { at?: string; hashes?: Record<string, string> } = JSON.parse(
    await readFile(snapshotFile(), "utf8").catch(() => "{}"),
  );
  const since = previous.at ?? null;
  let unrecorded: string[] = [];
  if (since && previous.hashes) {
    const old = previous.hashes;
    const written = new Set(
      (await readAudit())
        .filter((entry) => entry.ts >= since)
        .map((entry) => entry.path),
    );
    unrecorded = Object.keys(hashes).filter(
      (rel) =>
        old[rel] !== undefined && old[rel] !== hashes[rel] && !written.has(rel),
    );
  }
  const result: DriftResult = {
    at: now,
    since,
    records: Object.keys(hashes).length,
    unrecorded,
  };
  if (options.apply) {
    await mkdir(path.dirname(snapshotFile()), { recursive: true });
    await atomicWrite(
      snapshotFile(),
      `${JSON.stringify({ at: now, hashes })}\n`,
    );
    await atomicWrite(driftFile(), `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

export async function readDrift(): Promise<DriftResult | null> {
  try {
    const saved = JSON.parse(await readFile(driftFile(), "utf8"));
    return Array.isArray(saved.unrecorded) ? saved : null;
  } catch {
    return null;
  }
}
