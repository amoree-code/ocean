import { readFile } from "node:fs/promises";
import path from "node:path";
import { listCandidates } from "@ocean/brain/memory/memory-review.js";
import { proposeMemory } from "@ocean/brain/memory/memory-write.js";
import { MemoryContractError } from "@ocean/core/domain/mcp/memory-contract.js";
import { atomicWrite } from "@ocean/core/shared/fs-utils.js";
import { localDate } from "@ocean/core/shared/local-date.js";
import { oceanPath } from "@ocean/core/shared/paths.js";
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

// Each discovered topic without an interest file yet becomes one candidate (dry run unless apply).
export async function proposeDiscoveredInterests(options: {
  apply: boolean;
}): Promise<{
  proposed: string[];
  known: string[];
  // A candidate for the topic already waits for review, or the proposal was refused.
  pending: { topic: string; reason: string }[];
  found: DiscoveredInterest[];
}> {
  const found = await discoverStack();
  const existing = await listInterests();
  const have = new Set(
    existing.flatMap((interest) => [
      projectSlug(interest.name),
      ...interest.sources,
    ]),
  );
  const waiting = new Set((await listCandidates()).map((item) => item.target));
  const proposed: string[] = [];
  const known: string[] = [];
  const pending: { topic: string; reason: string }[] = [];
  for (const item of found) {
    const slug = projectSlug(item.topic);
    if (have.has(slug) || have.has(item.source)) {
      known.push(item.topic);
      continue;
    }
    if (waiting.has(`${INTERESTS_DIR}/${slug}.md`)) {
      pending.push({
        topic: item.topic,
        reason: "a candidate waits for review",
      });
      continue;
    }
    if (!options.apply) {
      proposed.push(item.topic);
      continue;
    }
    try {
      const { candidate } = await proposeMemory({
        content: `---\ntype: interest\npriority: medium\nkeywords: []\nsources: [${item.source}]\ncadence: weekly\norigin: discovered\nweight: 1\nlast_signal: ${localDate()}\n---\n\n# ${item.topic}\n\nUsed in: ${item.projects.join(", ")}.\n`,
        origin: "inferred",
        source: "interest-discovery",
        target: `${INTERESTS_DIR}/${slug}.md`,
        reason: `a dependency of ${item.projects.length} registered project(s)`,
        meta: { kind: "interest" },
      });
      proposed.push(candidate);
    } catch (error) {
      if (!(error instanceof MemoryContractError)) throw error;
      pending.push({
        topic: item.topic,
        reason: `${error.code}: ${error.message}`,
      });
    }
  }
  return { proposed, known, pending, found };
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
