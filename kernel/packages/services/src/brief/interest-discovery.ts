import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { listCandidates } from "@ocean/brain/memory/memory-review.js";
import { proposeMemory } from "@ocean/brain/memory/memory-write.js";
import { MemoryContractError } from "@ocean/core/domain/mcp/memory-contract.js";
import { atomicWrite, parseFrontmatter } from "@ocean/core/shared/fs-utils.js";
import { localDate } from "@ocean/core/shared/local-date.js";
import { DAILY_DIR, oceanPath } from "@ocean/core/shared/paths.js";
import {
  expandHome,
  listProjectManifests,
  projectSlug,
} from "@ocean/core/shared/project-resolution.js";
import { INTERESTS_DIR, listInterests } from "./brief.js";
import registry from "./source-registry.json" with { type: "json" };

// Interest discovery for any user (T-314). Ocean proposes, the owner decides: what the owner's
// registered projects depend on becomes a candidate interest following that library's releases;
// nothing is added without review. Decay and keep/skip feedback move an interest's weight.

type RegistryEntry = { topic: string; source: string };
const SOURCES: Record<string, RegistryEntry> = registry;

export type DiscoveredInterest = {
  topic: string;
  source: string;
  projects: string[];
};

// Packages the registered projects depend on, mapped through the source registry.
export async function discoverStack(): Promise<DiscoveredInterest[]> {
  const byTopic = new Map<string, DiscoveredInterest>();
  for (const manifest of await listProjectManifests()) {
    for (const folder of manifest.paths ?? []) {
      let pkg: Record<string, unknown>;
      try {
        // Paths are stored portable (`~/…`).
        pkg = JSON.parse(
          await readFile(path.join(expandHome(folder), "package.json"), "utf8"),
        );
      } catch {
        continue;
      }
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      for (const name of Object.keys(deps)) {
        const entry = Object.hasOwn(SOURCES, name) ? SOURCES[name] : null;
        if (!entry) continue;
        const found = byTopic.get(entry.topic) ?? {
          topic: entry.topic,
          source: entry.source,
          projects: [],
        };
        if (!found.projects.includes(manifest.id))
          found.projects.push(manifest.id);
        byTopic.set(entry.topic, found);
      }
    }
  }
  return [...byTopic.values()].sort(
    (a, b) =>
      b.projects.length - a.projects.length || a.topic.localeCompare(b.topic),
  );
}

export type InterestProposal = {
  topic: string;
  sources: string[];
  keywords: string[];
  reason: string;
  note: string;
};

export type ProposalResult = {
  proposed: string[];
  known: string[];
  // A candidate for the topic already waits for review, or the proposal was refused.
  pending: { topic: string; reason: string }[];
};

// Each topic without an interest file yet becomes one candidate (dry run unless apply). Shared by
// every way Ocean learns what the owner follows: his projects, his own answers, his sessions.
export async function proposeInterests(
  items: InterestProposal[],
  options: { apply: boolean; origin: string; source: string },
): Promise<ProposalResult> {
  const existing = await listInterests();
  const have = new Set(
    existing.flatMap((interest) => [
      projectSlug(interest.name),
      ...interest.sources,
    ]),
  );
  const waiting = new Set((await listCandidates()).map((item) => item.target));
  const result: ProposalResult = { proposed: [], known: [], pending: [] };
  const batch = new Set<string>();
  for (const item of items) {
    const slug = projectSlug(item.topic);
    // The same topic twice in one batch (stack and topics both name it) is one proposal.
    if (!slug || batch.has(slug)) continue;
    batch.add(slug);
    if (have.has(slug) || item.sources.some((source) => have.has(source))) {
      result.known.push(item.topic);
      continue;
    }
    if (waiting.has(`${INTERESTS_DIR}/${slug}.md`)) {
      result.pending.push({
        topic: item.topic,
        reason: "a candidate waits for review",
      });
      continue;
    }
    if (!options.apply) {
      result.proposed.push(item.topic);
      continue;
    }
    const list = (values: string[]) =>
      `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
    try {
      const { candidate } = await proposeMemory({
        content: `---\ntype: interest\npriority: medium\nkeywords: ${list(item.keywords)}\nsources: ${list(item.sources)}\ncadence: weekly\norigin: ${options.origin}\nweight: 1\nlast_signal: ${localDate()}\n---\n\n# ${item.topic.replace(/\s+/g, " ").trim()}\n\n${item.note}\n`,
        origin: "inferred",
        source: options.source,
        target: `${INTERESTS_DIR}/${slug}.md`,
        reason: item.reason,
        meta: { kind: "interest" },
      });
      result.proposed.push(candidate);
    } catch (error) {
      if (!(error instanceof MemoryContractError)) throw error;
      result.pending.push({
        topic: item.topic,
        reason: `${error.code}: ${error.message}`,
      });
    }
  }
  return result;
}

export async function proposeDiscoveredInterests(options: {
  apply: boolean;
}): Promise<ProposalResult & { found: DiscoveredInterest[] }> {
  const found = await discoverStack();
  const result = await proposeInterests(
    found.map((item) => ({
      topic: item.topic,
      sources: [item.source],
      keywords: [],
      reason: `a dependency of ${item.projects.length} registered project(s)`,
      note: `Used in: ${item.projects.join(", ")}.`,
    })),
    {
      apply: options.apply,
      origin: "discovered",
      source: "interest-discovery",
    },
  );
  return { ...result, found };
}

// A topic the owner names (setup's onboarding question) is matched to the registry by topic or
// package name for its feed; one the registry does not know is followed by its keywords alone.
export function topicProposal(topic: string, reason: string): InterestProposal {
  const wanted = topic.trim().toLowerCase();
  const entry = Object.entries(SOURCES).find(
    ([name, item]) => name === wanted || item.topic.toLowerCase() === wanted,
  )?.[1];
  return {
    topic: entry?.topic ?? topic.trim(),
    sources: entry ? [entry.source] : [],
    keywords: entry ? [] : [wanted],
    reason,
    note: entry ? "" : "Add a feed under sources to follow it in the brief.",
  };
}

const SIGNAL_SESSIONS = 3;

// Implicit signal: a registry topic named in at least three session records of the last `weeks`
// weeks (or a tag they carry) is proposed as an interest. Proposed, never added.
export async function sessionSignals(options: {
  weeks?: number;
  today?: string;
}): Promise<{ topic: string; sessions: number }[]> {
  const cutoff = new Date(
    Date.parse(options.today ?? localDate()) -
      (options.weeks ?? 4) * 7 * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);
  const topics = [...new Set(Object.values(SOURCES).map((item) => item.topic))];
  const counts = new Map<string, number>();
  const root = oceanPath(DAILY_DIR, "sessions");
  for (const month of await readdir(root).catch(() => [] as string[])) {
    if (!/^\d{4}-\d{2}$/.test(month) || `${month}-31` < cutoff) continue;
    for (const name of await readdir(path.join(root, month)).catch(
      () => [] as string[],
    )) {
      if (!name.endsWith(".md")) continue;
      const text = await readFile(path.join(root, month, name), "utf8").catch(
        () => "",
      );
      const fields = parseFrontmatter(text);
      if (fields.type !== "session" || (fields.date ?? "") < cutoff) continue;
      const seen = new Set<string>();
      for (const topic of topics)
        if (
          new RegExp(`(^|[^\\w.])${escapeRegex(topic)}(?![\\w])`, "i").test(
            text,
          )
        )
          seen.add(topic);
      const tags = /^tags:\s*\[(.*)\]/m.exec(text)?.[1] ?? "";
      for (const tag of tags.split(","))
        if (tag.trim()) seen.add(tag.trim().replace(/^["']|["']$/g, ""));
      for (const topic of seen) counts.set(topic, (counts.get(topic) ?? 0) + 1);
    }
  }
  return [...counts]
    .filter(([, sessions]) => sessions >= SIGNAL_SESSIONS)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([topic, sessions]) => ({ topic, sessions }));
}

const escapeRegex = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function proposeSignalInterests(options: {
  apply: boolean;
  weeks?: number;
  today?: string;
}): Promise<
  ProposalResult & { signals: { topic: string; sessions: number }[] }
> {
  const signals = await sessionSignals(options);
  const result = await proposeInterests(
    signals.map((signal) => ({
      ...topicProposal(
        signal.topic,
        `named in ${signal.sessions} recent session records`,
      ),
      note: `Came up in ${signal.sessions} sessions in the last ${options.weeks ?? 4} weeks.`,
    })),
    { apply: options.apply, origin: "signal", source: "session-signals" },
  );
  return { ...result, signals };
}

function setField(source: string, key: string, value: string): string {
  const end = source.indexOf("\n---", 3);
  if (!source.startsWith("---") || end < 0) return source;
  const head = source.slice(0, end);
  const line = new RegExp(`^${key}:.*$`, "m");
  const next = line.test(head)
    ? head.replace(line, `${key}: ${value}`)
    : `${head}\n${key}: ${value}`;
  return next + source.slice(end);
}

const WEIGHT_STEP = 0.25;
const clampWeight = (value: number) =>
  Math.round(Math.min(3, Math.max(0, value)) * 100) / 100;

async function readWeight(
  file: string,
): Promise<{ text: string; weight: number }> {
  const text = await readFile(oceanPath(file), "utf8");
  const weight = Number(/^weight:\s*([\d.]+)/m.exec(text)?.[1] ?? 1);
  return { text, weight: Number.isFinite(weight) ? weight : 1 };
}

// keep → weight up and a fresh signal; skip → weight down. Found by exact name or file slug.
export async function interestFeedback(
  name: string,
  verdict: "keep" | "skip",
  today = localDate(),
): Promise<{ file: string; weight: number }> {
  const wanted = projectSlug(name);
  const interest = (await listInterests()).find(
    (item) =>
      projectSlug(item.name) === wanted ||
      path.basename(item.file, ".md") === wanted,
  );
  if (!interest) throw new Error(`no interest named '${name}'`);
  const { text, weight } = await readWeight(interest.file);
  const next = clampWeight(
    weight + (verdict === "keep" ? WEIGHT_STEP : -WEIGHT_STEP),
  );
  let updated = setField(text, "weight", String(next));
  if (verdict === "keep") updated = setField(updated, "last_signal", today);
  await atomicWrite(oceanPath(interest.file), updated);
  return { file: interest.file, weight: next };
}

// An interest with no signal for `weeks` loses one step of weight (dry run unless apply). An
// interest the owner wrote himself (`origin: owner`, or none) is never decayed.
export async function decayInterests(options: {
  apply: boolean;
  weeks?: number;
  today?: string;
}): Promise<{ file: string; from: number; to: number }[]> {
  const today = Date.parse(options.today ?? localDate());
  const cutoff = today - (options.weeks ?? 8) * 7 * 24 * 60 * 60 * 1000;
  const changed: { file: string; from: number; to: number }[] = [];
  for (const interest of await listInterests()) {
    const { text, weight } = await readWeight(interest.file);
    const origin = /^origin:\s*(\S+)/m.exec(text)?.[1] ?? "owner";
    if (origin === "owner") continue;
    // The later of the last signal and the last decay: one step per window, not per run.
    const dates = [/^last_signal:\s*(\S+)/m, /^decayed:\s*(\S+)/m]
      .map((pattern) => Date.parse(pattern.exec(text)?.[1] ?? ""))
      .filter((time) => !Number.isNaN(time));
    if (dates.length && Math.max(...dates) >= cutoff) continue;
    const to = clampWeight(weight - WEIGHT_STEP);
    if (to === weight) continue;
    changed.push({ file: interest.file, from: weight, to });
    if (options.apply)
      await atomicWrite(
        oceanPath(interest.file),
        setField(
          setField(text, "weight", String(to)),
          "decayed",
          options.today ?? localDate(),
        ),
      );
  }
  return changed;
}
