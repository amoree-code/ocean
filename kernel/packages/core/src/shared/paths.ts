import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isValidProjectId,
  PROJECT_CATEGORY_FOLDERS,
  type ProjectCategory,
  UNCATEGORIZED,
} from "../domain/context/project-id.js";

// The engine root is the `ocean` package root — skills/, templates/, dist/main.js. Core
// cannot find it from its own location (in an installed tree the two packages can sit
// anywhere), so the CLI publishes it under this global key before core loads
// (packages/harness/src/engine-root.ts) — early enough for the module-level layout
// constants below. Without it (tests, or core imported directly) it is the workspace
// sibling packages/harness.
const ENGINE_ROOT_KEY = Symbol.for("ocean.engineRoot");
const workspaceEngineRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "harness",
);

export function registerEngineRoot(directory: string): void {
  (globalThis as Record<symbol, unknown>)[ENGINE_ROOT_KEY] =
    path.resolve(directory);
}

export function engineRoot(): string {
  const registered = (globalThis as Record<symbol, unknown>)[ENGINE_ROOT_KEY];
  return typeof registered === "string" ? registered : workspaceEngineRoot;
}

export function enginePath(...parts: string[]): string {
  return path.join(engineRoot(), ...parts);
}

// The entry clients and shims launch: the kernel checkout's own build.
export function liveEngineEntry(root = engineRoot()): string {
  return path.join(root, "dist", "main.js");
}

// The pnpm workspace root (kernel/), two directories above the engine root
// (packages/harness → packages → kernel). Repo-wide tooling that lives outside any
// workspace package (e.g. scripts/ shared across packages) is anchored here, not on
// engineRoot(), which is this package's own root.
export function repoRoot(): string {
  return path.resolve(engineRoot(), "..", "..");
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
export const WORKSPACE_PROJECT_CATEGORY: ProjectCategory = "personal";

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

// The folder name to use for a project id.
export function projectFolder(projectId: string): string {
  return isWorkspaceProject(projectId) ? WORKSPACE_PROJECT_ID : projectId;
}

// A project folder: its id, its category folder (absent while it still sits flat at
// 04-projects/<id>/) and its path relative to the Ocean root, `/`-separated.
export type ProjectDir = { id: string; category?: string; dir: string };

// Every project folder, in a category folder or flat, sorted by id. `_template`-style and dot
// folders are not projects. Both layouts are read until every project is moved (T-311).
export function listProjectDirs(root: string = oceanRoot()): ProjectDir[] {
  const children = (dir: string) => {
    try {
      return readdirSync(path.join(root, dir), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  };
  const found: ProjectDir[] = [];
  for (const name of children(PROJECTS_DIR)) {
    if (PROJECT_CATEGORY_FOLDERS.includes(name)) {
      const parent = path.posix.join(PROJECTS_DIR, name);
      for (const id of children(parent))
        if (isValidProjectId(id))
          found.push({
            id,
            category: name,
            dir: path.posix.join(parent, id),
          });
    } else if (isValidProjectId(name))
      found.push({ id: name, dir: path.posix.join(PROJECTS_DIR, name) });
  }
  // One id in two folders sorts in the order projectDir searches, so both pick the same one.
  const rank = (entry: ProjectDir) =>
    entry.category === undefined
      ? PROJECT_CATEGORY_FOLDERS.length
      : PROJECT_CATEGORY_FOLDERS.indexOf(entry.category);
  return found.sort((a, b) =>
    a.id === b.id ? rank(a) - rank(b) : a.id < b.id ? -1 : 1,
  );
}

// One project's folder relative to a 04-projects directory, `<category>/<id>` or a flat
// `<id>`: where it is now, or, for a project that does not exist yet, where a new one goes —
// UNCATEGORIZED, except the workspace's own project, which is the owner's: personal.
export function projectSubdir(projectsDir: string, projectId: string): string {
  const id = projectFolder(projectId);
  // Not an id (a category name, `..`): left as written for the caller's own checks to refuse.
  if (!isValidProjectId(id)) return id;
  for (const category of PROJECT_CATEGORY_FOLDERS)
    if (isDirectory(path.join(projectsDir, category, id)))
      return path.posix.join(category, id);
  if (isDirectory(path.join(projectsDir, id))) return id;
  return path.posix.join(
    id === WORKSPACE_PROJECT_ID ? WORKSPACE_PROJECT_CATEGORY : UNCATEGORIZED,
    id,
  );
}

// The same folder relative to the Ocean root.
export function projectDir(
  projectId: string,
  root: string = oceanRoot(),
): string {
  return path.posix.join(
    PROJECTS_DIR,
    projectSubdir(path.join(root, PROJECTS_DIR), projectId),
  );
}

// A path under PROJECTS_DIR, split into the project it names and what follows: either layout,
// `<id>/…` or `<category>/<id>/…`, so a path written before a project moved still finds it.
// Resolve the project's folder with projectDir, never from the category written here.
export function projectPathParts(
  parts: string[],
): { id: string; rest: string[] } | null {
  const [first, second, ...more] = parts;
  if (first && PROJECT_CATEGORY_FOLDERS.includes(first))
    return second && isValidProjectId(second)
      ? { id: second, rest: more }
      : null;
  return first && isValidProjectId(first)
    ? { id: first, rest: second === undefined ? [] : [second, ...more] }
    : null;
}

// A workspace-relative path with any category folder dropped (`04-projects/<id>/…`), so one
// record compares equal before and after its project moves between category folders.
export function withoutProjectCategory(relative: string): string {
  if (!relative.startsWith(`${PROJECTS_DIR}/`)) return relative;
  const project = projectPathParts(
    relative.slice(PROJECTS_DIR.length + 1).split("/"),
  );
  return project
    ? [PROJECTS_DIR, project.id, ...project.rest].join("/")
    : relative;
}

// Inverse of a project's tasks root (`<ocean>/04-projects/[<category>/]<id>/tasks`): the
// project id, or null for any other directory.
export function projectOfTasksRoot(root: string): string | null {
  const resolved = path.resolve(root);
  if (path.basename(resolved) !== "tasks") return null;
  const folder = path.dirname(resolved);
  const id = path.basename(folder);
  if (!isValidProjectId(id)) return null;
  const projects = path.resolve(oceanPath(PROJECTS_DIR));
  const parent = path.dirname(folder);
  if (parent === projects) return id;
  return path.dirname(parent) === projects &&
    PROJECT_CATEGORY_FOLDERS.includes(path.basename(parent))
    ? id
    : null;
}

export function workspaceTasksRoot(root: string = oceanRoot()): string {
  return path.join(root, projectDir(WORKSPACE_PROJECT_ID, root), "tasks");
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
// Project memory (T-296) is "project/<id>/<path>" for 04-projects/<id>/memory/<path>, and
// project docs (T-307) "project-docs/<id>/<path>" for 04-projects/<id>/docs/<path>.
// These map that convention back to the real PARA location.
function storeParts(storePath: string, root: string): string[] {
  const [store, ...rest] = storePath.split("/");
  if (store === "project" || store === "project-docs") {
    const [project, ...inside] = rest;
    if (!project || project === "." || project === "..")
      throw new Error(`invalid project store path '${storePath}'`);
    return [
      ...projectDir(project, root).split("/"),
      store === "project" ? "memory" : "docs",
      ...inside,
    ];
  }
  const dir = STORE_DIR[store as keyof typeof STORE_DIR];
  if (!dir) throw new Error(`unknown brain store '${store}'`);
  return [dir, ...rest];
}

export function resolveStorePath(root: string, storePath: string): string {
  return resolveWithin(root, ...storeParts(storePath, root));
}

export function storeRelativeToRoot(
  storePath: string,
  root: string = oceanRoot(),
): string {
  return storeParts(storePath, root).join("/");
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
  return root ? path.resolve(root) : defaultOceanRoot();
}

// A dev checkout (~/ocean/kernel/packages/harness) serves the workspace three directories up,
// once that holds one; a global npm install sits under the npm prefix, so it uses ~/ocean.
function defaultOceanRoot(): string {
  const checkoutParent = path.resolve(engineRoot(), "..", "..", "..");
  const isWorkspace = [
    "04-projects",
    "brain/04-projects",
    "bridge/sessions",
    "kernel/bridge/sessions",
  ].some((sentinel) => isDirectory(path.join(checkoutParent, sentinel)));
  return isWorkspace ? checkoutParent : path.join(homedir(), "ocean");
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
