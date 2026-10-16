import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  ContextManifest,
  ContextReference,
} from "@ocean/core/domain/context/context.js";
import { validateContextManifest } from "@ocean/core/domain/context/context-validator.js";
import type { Profile } from "@ocean/core/domain/profiles/profile.js";
import { oceanRoot } from "@ocean/core/shared/paths.js";
import {
  knownTaskPrefixes,
  projectRules,
  readProjectManifest,
  resolveProject,
} from "@ocean/core/shared/project-resolution.js";
import { resolveLadderRung } from "./context-ladder.js";
import { buildContextPacket } from "./context-packet.js";
import { classifyIntent } from "./intent-router.js";

// Lean context for headless runs: the prompt carries references (path + why), never file
// bodies. The provider is an agentic CLI with file access and reads a reference only if the
// request needs it. Two sources feed it: the profile's own contextSources and, when profile
// memory is enabled, the T-198 context packet for a request that names one exact record (a
// task id). Both go through the same realpath/allowedPaths boundary the old eager reader
// applied, so a headless prompt never points outside the profile's allowedPaths.

export const CONTEXT_REFERENCE_MAX_BYTES = 4_096;

// Within the context-ladder BUDGET_CEILING; the packet itself stats, never reads.
export const LEAN_PACKET_BUDGET = {
  maxFiles: 5,
  maxBytes: 200_000,
  maxChars: 8_000,
  maxOperationCost: 5,
};

const SECTION_HEADER =
  "## Context references\nBodies are not inlined; read a file only if the request needs it.";

async function sizeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}

async function canonicalBoundaries(
  allowedPaths: string[],
  cwd: string,
): Promise<string[]> {
  const boundaries = await Promise.all(
    allowedPaths.map(async (allowedPath) => {
      try {
        return await realpath(path.resolve(cwd, allowedPath));
      } catch {
        return null;
      }
    }),
  );
  return boundaries.filter((boundary): boundary is string => boundary !== null);
}

// The realpath/allowedPaths boundary carried over verbatim from the former eager context
// reader: a target that does not resolve, or whose canonical path (symlinks followed) lies
// outside every canonical allowedPath, is rejected. Returns the canonical path when allowed.
async function withinAllowedPaths(
  target: string,
  boundaries: string[],
): Promise<string | null> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(target);
  } catch {
    return null;
  }
  const allowed = boundaries.some(
    (boundary) =>
      canonicalPath === boundary ||
      canonicalPath.startsWith(`${boundary}${path.sep}`),
  );
  return allowed ? canonicalPath : null;
}

// Accepted contextSources entries are stat'd, never read.
export async function resolveContextSources(
  profile: Pick<Profile, "contextSources" | "allowedPaths">,
  cwd: string,
): Promise<{ references: ContextReference[]; omitted: string[] }> {
  const references: ContextReference[] = [];
  const omitted: string[] = [];
  const boundaries = await canonicalBoundaries(profile.allowedPaths, cwd);
  for (const relativePath of profile.contextSources) {
    const canonicalPath = await withinAllowedPaths(
      path.resolve(cwd, relativePath),
      boundaries,
    );
    if (!canonicalPath) {
      omitted.push(relativePath);
      continue;
    }
    references.push({
      path: relativePath,
      base: "cwd",
      recordType: "context-source",
      reason: "profile contextSources entry",
      bytes: await sizeOf(canonicalPath),
    });
  }
  return { references, omitted };
}

// References the context packet selects for the request. Only the exact-record rung (a task
// lookup naming one validated id) is used headlessly: memory/knowledge/decision lookups are
// keyword-triggered ("memory usage", "lessons", "best practice"), so they would point ordinary
// engineering prompts at private records. Every selected record must also lie inside the
// profile's allowedPaths (resolved against cwd); a rejected one goes to `omitted`. Unknown or
// low-confidence intents select nothing, and any error fails closed to no references, so a
// headless run never fails on a file it would not have read before.
export async function selectPacketReferences(
  prompt: string,
  cwd: string,
  allowedPaths: string[],
): Promise<{ references: ContextReference[]; omitted: string[] }> {
  const references: ContextReference[] = [];
  const omitted: string[] = [];
  try {
    const classification = classifyIntent(prompt, await knownTaskPrefixes());
    if (resolveLadderRung(classification).rung !== "exact-record")
      return { references, omitted };
    const packet = await buildContextPacket(
      classification,
      LEAN_PACKET_BUDGET,
      cwd,
    );
    const boundaries = await canonicalBoundaries(allowedPaths, cwd);
    for (const reference of packet.selectedReferences) {
      const canonicalPath = await withinAllowedPaths(
        path.join(oceanRoot(), reference.sourcePath),
        boundaries,
      );
      if (!canonicalPath) {
        omitted.push(reference.sourcePath);
        continue;
      }
      references.push({
        path: reference.sourcePath,
        base: "ocean-root",
        recordType: reference.recordType,
        reason: reference.selectionReason,
        bytes: await sizeOf(canonicalPath),
      });
    }
    return { references, omitted };
  } catch {
    return { references: [], omitted: [] };
  }
}

// The absolute file a reference points at (what the provider must be able to read).
export function referenceTarget(
  reference: ContextReference,
  cwd: string,
): string {
  return reference.base === "cwd"
    ? path.resolve(cwd, reference.path)
    : path.join(oceanRoot(), reference.path);
}

function inside(directory: string, root: string): boolean {
  return directory === root || directory.startsWith(`${root}${path.sep}`);
}

// The directories a workspace-restricted provider must be granted to open the references.
// Claude --add-dir and Gemini --include-directories grant a directory recursively, so a
// reference's canonical parent directory is granted only when that directory itself lies
// inside the profile's canonical allowedPaths: a single-file allowedPaths entry never widens
// to its siblings, and a symlinked entry grants its real location, not the link's folder.
// Directories inside the (canonical) cwd need no grant.
export async function referenceReadDirectories(
  references: ContextReference[],
  allowedPaths: string[],
  cwd: string,
): Promise<string[]> {
  const boundaries = await canonicalBoundaries(allowedPaths, cwd);
  let root: string;
  try {
    root = await realpath(cwd);
  } catch {
    root = path.resolve(cwd);
  }
  const directories = new Set<string>();
  for (const reference of references) {
    const canonicalPath = await withinAllowedPaths(
      referenceTarget(reference, cwd),
      boundaries,
    );
    if (!canonicalPath) continue;
    const directory = path.dirname(canonicalPath);
    if (inside(directory, root)) continue;
    if (!(await withinAllowedPaths(directory, boundaries))) continue;
    directories.add(directory);
  }
  return [...directories];
}

function renderReference(reference: ContextReference): string {
  const target =
    reference.base === "cwd"
      ? reference.path
      : path.join(oceanRoot(), reference.path);
  const bytes = reference.bytes === null ? "?" : String(reference.bytes);
  const reason = reference.reason.replace(/\s*\n\s*/g, " ");
  return `- ${target} (${reference.recordType}, ${bytes} B): ${reason}`;
}

function renderProjectRules(rules: {
  project: string;
  rules: string[];
}): string {
  return [
    `## Project rules (${rules.project})`,
    ...rules.rules.map((rule) => `- ${rule}`),
  ].join("\n");
}

// A bound project's rules ride in every headless run there, whatever the prompt or the profile's
// memory setting. Unreadable rules refuse the run (the error is not swallowed): a hard constraint
// is never silently dropped.
async function boundProjectRulesBlock(cwd: string): Promise<string> {
  // A broken registry leaves no bound project to read rules from (the headless path never
  // failed on it before); the session-start hook treats it the same way.
  const resolution = await resolveProject(cwd).catch(() => null);
  if (resolution?.status !== "bound") return "";
  const project = resolution.projectId;
  let rules: string[];
  try {
    const manifest = await readProjectManifest(project);
    rules = manifest ? projectRules(manifest) : [];
  } catch (error) {
    throw new Error(
      `Project rules (${project}) unreadable: ${error instanceof Error ? error.message : String(error)} — fix 04-projects/${project}/project.json`,
    );
  }
  return rules.length ? renderProjectRules({ project, rules }) : "";
}

export async function buildContextReferences(options: {
  profile: Pick<Profile, "contextSources" | "allowedPaths" | "memory">;
  prompt: string;
  cwd: string;
}): Promise<{
  content: string;
  manifest: ContextManifest;
  readDirectories: string[];
}> {
  const { profile, prompt, cwd } = options;
  const sources = await resolveContextSources(profile, cwd);
  const packet = profile.memory.enabled
    ? await selectPacketReferences(prompt, cwd, profile.allowedPaths)
    : { references: [], omitted: [] };
  const rulesBlock = await boundProjectRulesBlock(cwd);
  // The rules come first and are never squeezed out; the references fit in what is left.
  const referenceBudget = rulesBlock
    ? CONTEXT_REFERENCE_MAX_BYTES - Buffer.byteLength(rulesBlock) - 2
    : CONTEXT_REFERENCE_MAX_BYTES;
  const seen = new Set<string>();
  const candidates = [...sources.references, ...packet.references].filter(
    (reference) => {
      const key = `${reference.base}:${reference.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  );

  const omitted = [...sources.omitted, ...packet.omitted];
  const lines: string[] = [];
  const references: ContextReference[] = [];
  const overflow: ContextReference[] = [];
  for (const reference of candidates) {
    const line = renderReference(reference);
    const next = [SECTION_HEADER, ...lines, line].join("\n");
    if (overflow.length === 0 && Buffer.byteLength(next) <= referenceBudget) {
      lines.push(line);
      references.push(reference);
    } else {
      overflow.push(reference);
    }
  }
  if (overflow.length) {
    // Make room for the trailing note by dropping accepted lines if necessary.
    const note = (count: number) =>
      `- ... ${count} more references omitted (listed in the context_manifest event)`;
    while (
      lines.length &&
      Buffer.byteLength(
        [SECTION_HEADER, ...lines, note(overflow.length)].join("\n"),
      ) > referenceBudget
    ) {
      lines.pop();
      const dropped = references.pop();
      if (dropped) overflow.unshift(dropped);
    }
    lines.push(note(overflow.length));
    omitted.push(...overflow.map((reference) => reference.path));
  }

  const referencesBlock = lines.length
    ? [SECTION_HEADER, ...lines].join("\n")
    : "";
  const content = [rulesBlock, referencesBlock].filter(Boolean).join("\n\n");
  return {
    content,
    readDirectories: await referenceReadDirectories(
      references,
      profile.allowedPaths,
      cwd,
    ),
    manifest: validateContextManifest({
      files: references
        .filter((reference) => reference.base === "cwd")
        .map((reference) => reference.path),
      bytes: Buffer.byteLength(content),
      compactedSummary: null,
      lastContextCheckpoint: new Date().toISOString(),
      maxBytes: CONTEXT_REFERENCE_MAX_BYTES,
      omitted,
      compression: null,
      references,
    }),
  };
}
