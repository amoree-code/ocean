import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

// This module always lives one directory below the engine package root, whether it
// runs compiled from dist/ or directly from src/ under tsx.
const engineDirectory = path.resolve(moduleDirectory, "..");

// The default runtime data root is the private workspace root, e.g.
// ~/ocean/kernel/packages/core (this package) sits three directories below ~/ocean
// (kernel, packages, core), which holds the record areas and the bridge
// (see PERSONAL_DIR/PROJECTS_DIR/SYSTEM_DIR below).
const defaultOceanRoot = path.resolve(engineDirectory, "..", "..", "..");

export function engineRoot(): string {
  return engineDirectory;
}

export function enginePath(...parts: string[]): string {
  return path.join(engineRoot(), ...parts);
}

// The pnpm workspace root (engine/), two directories above this package
// (packages/core → packages → engine). Repo-wide tooling that lives outside any
// workspace package (e.g. scripts/ shared across packages) is anchored here, not on
// engineRoot(), which is this package's own root.
export function repoRoot(): string {
  return path.resolve(engineDirectory, "..", "..");
}

export function repoPath(...parts: string[]): string {
  return path.join(repoRoot(), ...parts);
}

// Single point of truth for the top-level layout under oceanRoot(). Flipped in
// T-224 stage B to the Ocean/PARA layout (~/ocean/brain/..., ~/ocean/kernel/bridge)
// now that every call site (stage A) reads these constants instead of a literal.
//
// T-243 phase 6 flattens it: brain/<area> moves up to <area>, and kernel/bridge leaves the
// public repo for bridge. Each half keys on a sentinel directory it always holds — never on a
// bare folder, so an empty one created by accident cannot hide the real data — and falls back
// to the old location, so one build runs before, during and after the data move. Decided once
// per process against the root it starts with; a process started before the move keeps the old
// layout until it restarts.
function layoutPrefix(
  root: string,
  flat: string,
  nested: string,
  sentinel: string,
): string {
  if (isDirectory(path.join(root, flat, sentinel))) return flat;
  if (isDirectory(path.join(root, nested, sentinel))) return nested;
  return flat;
}
const recordsPrefix = (root: string) =>
  layoutPrefix(root, "", "brain", "04-projects");
const bridgePrefix = (root: string) =>
  layoutPrefix(root, "bridge", "kernel/bridge", "sessions");

// Which layout each half of a root is on, by the same rule the constants below are built with.
export function workspaceLayout(root: string = oceanRoot()): {
  records: "flat" | "nested";
  bridge: "flat" | "nested";
} {
  return {
    records: recordsPrefix(root) === "" ? "flat" : "nested",
    bridge: bridgePrefix(root) === "bridge" ? "flat" : "nested",
  };
}

const BRAIN_PREFIX = recordsPrefix(oceanRoot());
const brainArea = (area: string) => path.posix.join(BRAIN_PREFIX, area);
//
// The old flat `personal/` directory had five children (memory, knowledge, daily,
// inbox[+brain-dump], templates) that PARA scatters to five independent, sibling
// top-level folders under brain/ — not one renamed parent with the same children
// underneath. PERSONAL_DIR alone can't stand in for all five the way SYSTEM_DIR
// and PROJECTS_DIR still can for their own (uniform) subtrees, so each gets its
// own constant. PERSONAL_DIR keeps meaning what `personal/memory` meant: it is
// 02-personal itself, not a parent with a further "memory" segment under it.
export const PERSONAL_DIR = brainArea("02-personal");
export const KNOWLEDGE_DIR = brainArea("05-knowledge");
export const DAILY_DIR = brainArea("01-daily");
export const INBOX_DIR = brainArea("00-inbox");
export const TEMPLATES_DIR = brainArea("06-templates");
export const INDEX_DIR = brainArea(".index");
export const PROJECTS_DIR = brainArea("04-projects");
// Every top-level brain area that holds markdown records (used by the doctor and the
// context command to scan the private store).
export const BRAIN_RECORD_DIRS = [
  INBOX_DIR,
  DAILY_DIR,
  PERSONAL_DIR,
  brainArea("03-professional"),
  KNOWLEDGE_DIR,
  TEMPLATES_DIR,
] as const;
// The workspace's own project. Callers use these helpers instead of a literal.
export const WORKSPACE_PROJECT_ID = "ocean";

export function sameProject(a: string, b: string): boolean {
  return a === b || (isWorkspaceProject(a) && isWorkspaceProject(b));
}

export function isWorkspaceProject(projectId: string): boolean {
  return projectId.toLowerCase() === WORKSPACE_PROJECT_ID;
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

// The folder name to use under PROJECTS_DIR for a project id.
export function projectFolder(projectId: string): string {
  return isWorkspaceProject(projectId) ? WORKSPACE_PROJECT_ID : projectId;
}

export function workspaceTasksRoot(root: string = oceanRoot()): string {
  return path.join(root, PROJECTS_DIR, WORKSPACE_PROJECT_ID, "tasks");
}

export const SYSTEM_DIR = bridgePrefix(oceanRoot());
export const REGISTRY_DIR = `${SYSTEM_DIR}/registry`;
export const LEGACY_REGISTRY_DIR = `${SYSTEM_DIR}/control-plane/registry`;
// Governance is private: the charter and the policies it routes to live in the brain.
export const CHARTER_DIR = brainArea("charter");
export const POLICIES_DIR = `${CHARTER_DIR}/policies`;

// The brain index (brain-reindex.ts, brain-service.ts, context-ladder.ts) stores and
// resolves records as "<store>/<relative path>" (e.g. "memory/foo.md",
// "knowledge/decisions/bar.md") — a format that predates the PARA split and is kept as
// the on-disk/index convention. This is the one place that maps a store name back to its
// real root, now that "memory" and "knowledge" are no longer subfolders of one shared
// parent.
export const STORE_DIR = {
  memory: PERSONAL_DIR,
  knowledge: KNOWLEDGE_DIR,
} as const;

// Brain-index records are "<store>/<path inside store>" ("memory/x.md", "knowledge/decisions/y.md").
// These map that convention back to the real PARA location.
export function resolveStorePath(root: string, storePath: string): string {
  const [store, ...rest] = storePath.split("/");
  const dir = STORE_DIR[store as keyof typeof STORE_DIR];
  if (!dir) throw new Error(`unknown brain store '${store}'`);
  return resolveWithin(root, dir, ...rest);
}

export function storeRelativeToRoot(storePath: string): string {
  const [store, ...rest] = storePath.split("/");
  const dir = STORE_DIR[store as keyof typeof STORE_DIR];
  if (!dir) throw new Error(`unknown brain store '${store}'`);
  return [dir, ...rest].join("/");
}

export function oceanEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[`OCEAN_${name}`];
}

export function oceanEnvPair(
  name: string,
  value: string,
): Record<string, string> {
  return { [`OCEAN_${name}`]: value };
}

export function oceanRoot(): string {
  const root = oceanEnv("ROOT");
  return root ? path.resolve(root) : defaultOceanRoot;
}

export function oceanPath(...parts: string[]): string {
  return path.join(oceanRoot(), ...parts);
}

// path.resolve is purely lexical: it never follows symlinks. Resolves the real location
// of the deepest existing ancestor of `candidate` and rejoins the (possibly not-yet-created)
// remainder onto it, so a caller can bounds-check a write target that doesn't exist yet
// without requiring the whole path to exist first.
export function realDeepestExisting(candidate: string): string {
  let current = candidate;
  const pendingSuffix: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(current), ...pendingSuffix.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return candidate;
      pendingSuffix.push(path.basename(current));
      current = parent;
    }
  }
}

function escapesRoot(root: string, candidate: string): boolean {
  const isFilesystemRoot = root === path.parse(root).root;
  return (
    candidate !== root &&
    !isFilesystemRoot &&
    !candidate.startsWith(`${root}${path.sep}`)
  );
}

export function resolveWithin(root: string, ...parts: string[]): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...parts);
  if (escapesRoot(resolvedRoot, resolved)) {
    throw new Error("Path escapes its allowed root");
  }
  // A symlink anywhere under the lexically-allowed path can still point outside root; the
  // lexical check above can't see that. Re-check against each path's real location too.
  const realRoot = realDeepestExisting(resolvedRoot);
  const realResolved = realDeepestExisting(resolved);
  if (escapesRoot(realRoot, realResolved)) {
    throw new Error("Path escapes its allowed root");
  }
  return resolved;
}
