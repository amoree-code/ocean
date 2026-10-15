import { execFile } from "node:child_process";
import {
  type Dirent,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  derivePrefix,
  formatTaskId,
  isValidPrefix,
  LEGACY_PREFIX,
} from "../../domain/tasks/task-id.js";
import { atomicWrite, registryFile, withFileLock } from "../../fs-utils.js";
import {
  isWorkspaceProject,
  oceanEnv,
  oceanPath,
  oceanRoot,
  PROJECTS_DIR,
  projectFolder,
  WORKSPACE_PROJECT_ID,
} from "../../paths.js";

// Deterministic, local, metadata-first project resolution: no model call, no network round
// trip. Bindings are a flat JSON registry (same pattern as kernel/bridge/registry/
// providers.json), not a new workspace root.
export type ProjectBinding = {
  id: string;
  name: string;
  path: string;
  gitRoot: string | null;
  boundAt: string;
  // True when the binding comes from a project.json, absent for a legacy registry entry.
  manifest?: boolean;
};

export type ProjectResolution =
  | {
      status: "bound";
      projectId: string;
      name: string;
      path: string;
      matchedOn: "git-root" | "cwd" | "path" | "ocean-root";
      confidence: "high";
    }
  | {
      status: "unbound";
      cwd: string;
      gitRoot: string | null;
      confidence: "none";
    }
  | {
      status: "ambiguous";
      cwd: string;
      candidates: ProjectBinding[];
      confidence: "low";
    };

export function projectConfirmationQuestion(
  resolution: ProjectResolution,
): string | null {
  if (resolution.status === "bound") return null;
  if (resolution.status === "ambiguous")
    return "Which Ocean project should this request use? Specify the project name or binding path.";
  return "Which Ocean project should this request use? Provide the project name and path to bind it.";
}

function bindingsFile(): string {
  return registryFile("project-bindings.json");
}

export function findGitRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  while (true) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// A linked worktree (`git worktree add`) has a `.git` file pointing into the main repo's
// `.git/worktrees/<name>`; returns that main repo, or null for a normal repo or a submodule.
export function linkedWorktreeMain(gitRoot: string): string | null {
  try {
    const dotGit = path.join(gitRoot, ".git");
    if (!statSync(dotGit).isFile()) return null;
    const pointer = readFileSync(dotGit, "utf8").match(
      /^gitdir:\s*(.+)$/m,
    )?.[1];
    if (!pointer) return null;
    const gitdir = path.resolve(gitRoot, pointer.trim());
    const match = gitdir.match(/^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

const execFileAsync = promisify(execFile);

// `git status --short` lines for the repo containing `directory`; [] when it is not a repo or
// git fails. --no-optional-locks: sessions share working trees, and a status that refreshes the
// index would take index.lock and fail another session's concurrent add/commit (T-257).
export async function gitChangedFiles(
  directory: string,
  timeout = 1_000,
): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["--no-optional-locks", "-C", directory, "status", "--short"],
      { timeout, maxBuffer: 1024 * 1024 },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// The project folder is the project (T-256): `04-projects/<id>/project.json` is the single
// source of truth for identity and paths. Paths are stored `~`-relative so the same record
// works for any user name or machine, and expanded when read.
export type ProjectManifest = {
  id: string;
  name: string;
  paths: string[];
  created: string;
  autoRegistered: boolean;
  // Task id namespace (OL -> OL-001) and the next number to issue. Both optional: a project
  // without a prefix keeps issuing the legacy T-<n> ids.
  prefix?: string;
  nextTask?: number;
};

const MANIFEST_FILE = "project.json";

export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\"))
    return path.join(os.homedir(), value.slice(2));
  return value;
}

export function portablePath(value: string): string {
  const home = os.homedir();
  const resolved = path.resolve(value);
  if (resolved === home) return "~";
  if (resolved.startsWith(`${home}${path.sep}`))
    return `~/${path.relative(home, resolved).split(path.sep).join("/")}`;
  return resolved;
}

import { isValidProjectId } from "../../domain/context/project-id.js";

export { isValidProjectId };

// One spelling per directory: symlinks resolved (macOS /var is /private/var, and process.cwd()
// returns the resolved form), so a bound path and the cwd of a session inside it compare equal.
// A path that does not exist (a repo not cloned on this machine yet) is kept as written.
export function canonicalPath(value: string): string {
  const resolved = path.resolve(expandHome(value));
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function projectsRoot(): string {
  return oceanPath(PROJECTS_DIR);
}

function manifestPath(projectId: string): string {
  return path.join(projectsRoot(), projectFolder(projectId), MANIFEST_FILE);
}

function parseManifest(folder: string, raw: string) {
  const parsed = JSON.parse(raw) as Partial<ProjectManifest>;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray(parsed.paths) ||
    parsed.paths.some((entry) => typeof entry !== "string" || !entry.trim())
  )
    throw new Error("paths must be a list of non-empty strings");
  if (
    parsed.prefix !== undefined &&
    (typeof parsed.prefix !== "string" ||
      parsed.prefix === LEGACY_PREFIX ||
      !isValidPrefix(parsed.prefix))
  )
    throw new Error(
      `prefix '${String(parsed.prefix)}' is not a valid task prefix`,
    );
  if (
    parsed.nextTask !== undefined &&
    (!Number.isInteger(parsed.nextTask) || (parsed.nextTask as number) < 1)
  )
    throw new Error("nextTask must be a positive integer");
  // The folder name is the id; a manifest cannot claim another project's identity.
  return {
    id: folder,
    name: typeof parsed.name === "string" && parsed.name ? parsed.name : folder,
    paths: parsed.paths,
    created: typeof parsed.created === "string" ? parsed.created : "",
    autoRegistered: parsed.autoRegistered === true,
    ...(parsed.prefix !== undefined ? { prefix: parsed.prefix } : {}),
    ...(parsed.nextTask !== undefined ? { nextTask: parsed.nextTask } : {}),
  } satisfies ProjectManifest;
}

export type ProjectManifestScan = {
  manifests: ProjectManifest[];
  errors: Array<{ file: string; error: string }>;
};

// A broken project.json takes only its own project out of resolution: resolveProject runs in
// every session's start hook, so one bad file must not break every project. The errors are
// returned for `ocean project list` to report.
export async function scanProjectManifests(): Promise<ProjectManifestScan> {
  const scan: ProjectManifestScan = { manifests: [], errors: [] };
  let folders: string[];
  try {
    folders = (await readdir(projectsRoot(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isValidProjectId(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return scan;
    throw error;
  }
  for (const folder of folders) {
    const file = path.join(projectsRoot(), folder, MANIFEST_FILE);
    try {
      scan.manifests.push(parseManifest(folder, await readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      scan.errors.push({
        file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return scan;
}

export async function listProjectManifests(): Promise<ProjectManifest[]> {
  return (await scanProjectManifests()).manifests;
}

export async function writeManifest(manifest: ProjectManifest): Promise<void> {
  const file = manifestPath(manifest.id);
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

// Bindings recorded before T-256, read from the flat registry file. Kept as a fallback until
// `ocean project migrate --write` folds them into manifests, and rewritten as a cache after
// every manifest change for anything that still reads the file. Entries the cache holds for
// manifests are skipped, so a deleted project folder does not come back through it.
// A corrupt file throws: resolution fails closed (no project, no task references) and writers
// never overwrite what they cannot read. The session-start hook catches it on its own.
async function listLegacyBindings(): Promise<ProjectBinding[]> {
  try {
    const raw = await readFile(bindingsFile(), "utf8");
    const parsed = JSON.parse(raw) as {
      version: number;
      bindings: ProjectBinding[];
    };
    if (!Array.isArray(parsed?.bindings ?? []))
      throw new Error(`${bindingsFile()}: bindings is not a list`);
    return (parsed.bindings ?? []).filter((binding) => !binding.manifest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

// gitRoot is left null here: resolution matches on paths, and walking up from every path of
// every project on each session start would cost a filesystem walk per path for nothing.
function manifestBindings(manifests: ProjectManifest[]): ProjectBinding[] {
  return manifests.flatMap((manifest) =>
    manifest.paths.map((stored) => ({
      id: manifest.id,
      name: manifest.name,
      path: canonicalPath(stored),
      gitRoot: null,
      boundAt: manifest.created,
      manifest: true,
    })),
  );
}

function combineBindings(
  manifests: ProjectManifest[],
  legacy: ProjectBinding[],
): ProjectBinding[] {
  const fromManifests = manifestBindings(manifests);
  const claimed = new Set(fromManifests.map((binding) => binding.path));
  return [
    ...fromManifests,
    ...legacy
      .map((binding) => ({ ...binding, path: canonicalPath(binding.path) }))
      .filter((binding) => !claimed.has(binding.path)),
  ];
}

export async function listProjectBindings(): Promise<ProjectBinding[]> {
  return combineBindings(
    await listProjectManifests(),
    await listLegacyBindings(),
  );
}

// The cache keeps every legacy entry, including ones a manifest now claims, so deleting that
// manifest later never loses the old binding.
function cacheBindings(
  manifests: ProjectManifest[],
  legacy: ProjectBinding[],
): ProjectBinding[] {
  return [...manifestBindings(manifests), ...legacy];
}

async function saveProjectBindings(bindings: ProjectBinding[]): Promise<void> {
  const file = bindingsFile();
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(
    file,
    `${JSON.stringify({ version: 1, bindings }, null, 2)}\n`,
  );
}

// One lock for every manifest/cache write: bindings are checked across all projects (a path
// may belong to one project only), so per-project locks would let two writers both pass.
export function withProjectsLock<T>(run: () => Promise<T>): Promise<T> {
  return withFileLock(bindingsFile(), run);
}

// A manifest for a project seen for the first time. A folder with no tasks gets its own task
// prefix and counter; one that already holds tasks stays on the legacy T namespace until
// `ocean tasks renumber`. The workspace project is always T.
async function newManifest(
  id: string,
  fields: Pick<
    ProjectManifest,
    "name" | "paths" | "created" | "autoRegistered"
  >,
  others: ProjectManifest[],
): Promise<ProjectManifest> {
  const manifest: ProjectManifest = { id, ...fields };
  if (isWorkspaceProject(id)) return manifest;
  const tasks = await readdir(
    path.join(projectsRoot(), projectFolder(id), "tasks"),
  ).catch(() => []);
  if (tasks.some((entry) => !entry.startsWith("."))) return manifest;
  const taken = others.flatMap((other) => (other.prefix ? [other.prefix] : []));
  return { ...manifest, prefix: derivePrefix(id, taken), nextTask: 1 };
}

export async function knownTaskPrefixes(): Promise<string[]> {
  const prefixes = (await listProjectManifests()).flatMap((manifest) =>
    manifest.prefix ? [manifest.prefix] : [],
  );
  return [LEGACY_PREFIX, ...new Set(prefixes)];
}

// The project that owns a non-legacy prefix; null for T (the caller's own project) or a prefix
// nobody uses. Two manifests claiming one prefix is a configuration error, never a guess.
export async function projectForPrefix(prefix: string): Promise<string | null> {
  if (prefix === LEGACY_PREFIX) return null;
  const owners = (await listProjectManifests())
    .filter((manifest) => manifest.prefix === prefix)
    .map((manifest) => manifest.id);
  if (owners.length > 1)
    throw new Error(
      `prefix ${prefix} is claimed by ${owners.join(", ")}; fix project.json`,
    );
  return owners[0] ?? null;
}

const TASK_NUMBER_SCAN_DEPTH = 2;

// Highest <prefix>-<n> folder under every project's tasks/, live and archived. Archives are
// tasks/archive/<namespace>/<id> (or flat archive/<id>), so descend archive/ two levels.
// Every project is scanned because the legacy T sequence was shared by all of them.
export async function highestTaskNumber(prefix: string): Promise<number> {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let highest = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = pattern.exec(entry.name);
      if (match) highest = Math.max(highest, Number(match[1]));
      else if (
        depth < TASK_NUMBER_SCAN_DEPTH &&
        (depth > 0 || entry.name === "archive")
      )
        await visit(path.join(directory, entry.name), depth + 1);
    }
  };
  let projects: Dirent[];
  try {
    projects = await readdir(projectsRoot(), { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const project of projects)
    if (project.isDirectory() && !project.name.startsWith("."))
      await visit(path.join(projectsRoot(), project.name, "tasks"), 0);
  return highest;
}

async function nextTaskNumber(
  projectId: string,
): Promise<{ prefix: string; number: number; manifest?: ProjectManifest }> {
  const folder = projectFolder(projectId);
  const manifests = await listProjectManifests();
  const manifest = manifests.find((candidate) => candidate.id === folder);
  const prefix = manifest?.prefix ?? LEGACY_PREFIX;
  // T is one namespace shared by every project without a prefix: each honours the highest
  // counter among them, so numbers a renumber moved out of the scan are never reissued.
  const floor =
    prefix === LEGACY_PREFIX
      ? Math.max(
          1,
          ...manifests
            .filter((candidate) => !candidate.prefix)
            .map((candidate) => candidate.nextTask ?? 1),
        )
      : (manifest?.nextTask ?? 1);
  const number = Math.max(floor, (await highestTaskNumber(prefix)) + 1);
  return { prefix, number, manifest };
}

// The id the next task of this project would get. A prediction only: another writer may take
// it before the caller writes, so a write goes through withNextTaskId.
export async function peekNextTaskId(projectId: string): Promise<string> {
  return withProjectsLock(async () => {
    const next = await nextTaskNumber(projectId);
    return formatTaskId(next.prefix, next.number);
  });
}

// Issues the next id and runs the write under the projects lock, so two creators never get one
// id. The counter advances only when the write succeeded; a refused write consumes nothing.
export async function withNextTaskId<T extends { ok: boolean }>(
  projectId: string,
  run: (id: string) => Promise<T>,
): Promise<T> {
  return withProjectsLock(async () => {
    const next = await nextTaskNumber(projectId);
    const result = await run(formatTaskId(next.prefix, next.number));
    if (result.ok && next.manifest)
      await writeManifest({ ...next.manifest, nextTask: next.number + 1 });
    return result;
  });
}

// Resolves the active Ocean project from a working directory: no terminal-in-Ocean
// requirement. Match order is git root, then the exact cwd, then (as a last resort) whether
// the path is inside the Ocean workspace root itself, which is always the workspace project.
export async function resolveProject(cwd: string): Promise<ProjectResolution> {
  const resolvedCwd = canonicalPath(cwd);
  const gitRoot = findGitRoot(resolvedCwd);
  const bindings = await listProjectBindings();

  const containing = bindings
    .filter((binding) => {
      const bound = path.resolve(binding.path);
      return (
        resolvedCwd === bound || resolvedCwd.startsWith(`${bound}${path.sep}`)
      );
    })
    .sort((a, b) => path.resolve(b.path).length - path.resolve(a.path).length);
  if (
    containing.length &&
    (!containing[1] ||
      path.resolve(containing[0].path).length >
        path.resolve(containing[1].path).length)
  ) {
    const binding = containing[0];
    return {
      status: "bound",
      projectId: binding.id,
      name: binding.name,
      path: binding.path,
      matchedOn: path.resolve(binding.path) === resolvedCwd ? "cwd" : "path",
      confidence: "high",
    };
  }
  if (containing.length > 1)
    return {
      status: "ambiguous",
      cwd: resolvedCwd,
      candidates: containing,
      confidence: "low",
    };

  const gitRootMatch = gitRoot
    ? bindings.filter((binding) => path.resolve(binding.path) === gitRoot)
    : [];
  if (gitRootMatch.length === 1) {
    return {
      status: "bound",
      projectId: gitRootMatch[0].id,
      name: gitRootMatch[0].name,
      path: gitRootMatch[0].path,
      matchedOn: "git-root",
      confidence: "high",
    };
  }
  if (gitRootMatch.length > 1) {
    return {
      status: "ambiguous",
      cwd: resolvedCwd,
      candidates: gitRootMatch,
      confidence: "low",
    };
  }

  // A worktree beside its repo (house convention: <repo>-worktrees/<slug>) is that repo's project.
  const main = gitRoot ? linkedWorktreeMain(gitRoot) : null;
  if (main && main !== gitRoot) {
    const viaMain = await resolveProject(main);
    if (viaMain.status === "bound") return viaMain;
  }

  const root = canonicalPath(oceanRoot());
  const isFilesystemRoot = root === path.parse(root).root;
  if (
    resolvedCwd === root ||
    isFilesystemRoot ||
    resolvedCwd.startsWith(`${root}${path.sep}`)
  ) {
    return {
      status: "bound",
      projectId: WORKSPACE_PROJECT_ID,
      name: "Ocean",
      path: root,
      matchedOn: "ocean-root",
      confidence: "high",
    };
  }

  return { status: "unbound", cwd: resolvedCwd, gitRoot, confidence: "none" };
}

export type BindProjectResult = {
  binding: ProjectBinding;
  created: boolean;
  conflict?: ProjectBinding;
};

// Explicit registration/binding: never guesses on a name or path collision, always returns
// the conflict instead of silently overwriting an existing binding. `addPath` is the one
// deliberate exception: it adds another repo to an existing project (dashboard + backend).
export async function bindProject(
  name: string,
  targetPath: string,
  options: { addPath?: boolean; autoRegistered?: boolean } = {},
): Promise<BindProjectResult> {
  if (!isValidProjectId(name))
    throw new Error(
      `Invalid project id '${name}': use lowercase letters, digits, dot, underscore or hyphen`,
    );
  const resolvedPath = canonicalPath(targetPath);
  return withProjectsLock(async () => {
    const manifests = await listProjectManifests();
    const legacy = await listLegacyBindings();
    const bindings = combineBindings(manifests, legacy);
    const existingAtPath = bindings.find(
      (binding) => path.resolve(binding.path) === resolvedPath,
    );
    if (existingAtPath && existingAtPath.id !== name)
      return {
        binding: existingAtPath,
        created: false,
        conflict: existingAtPath,
      };
    if (existingAtPath?.manifest)
      return { binding: existingAtPath, created: false };
    // From here the path is free, or is this project's own legacy binding being folded in,
    // which is never a conflict.
    const existingByName = bindings.find(
      (binding) => binding.id === name && binding.path !== resolvedPath,
    );
    if (existingByName && !existingAtPath && !options.addPath)
      return {
        binding: existingByName,
        created: false,
        conflict: existingByName,
      };
    const existing = manifests.find((manifest) => manifest.id === name);
    // Auto-registration never takes over a folder someone else made (checked under the lock,
    // so a folder created a moment ago by another writer counts).
    if (
      options.autoRegistered &&
      !existing &&
      existsSync(path.join(projectsRoot(), projectFolder(name)))
    )
      throw new ProjectFolderTaken(
        `04-projects/${name} already exists; bind it explicitly`,
      );
    const manifest: ProjectManifest = existing
      ? { ...existing, paths: [...existing.paths, portablePath(resolvedPath)] }
      : await newManifest(
          name,
          {
            name,
            paths: [portablePath(resolvedPath)],
            created: new Date().toISOString(),
            autoRegistered: options.autoRegistered === true,
          },
          manifests,
        );
    await writeManifest(manifest);
    const updated = manifests
      .filter((candidate) => candidate.id !== name)
      .concat(manifest);
    const next = combineBindings(updated, legacy);
    await saveProjectBindings(cacheBindings(updated, legacy));
    const binding = next.find(
      (candidate) => candidate.path === resolvedPath,
    ) as ProjectBinding;
    return { binding, created: true };
  });
}

export type ProjectMigration = {
  migrated: Array<{ id: string; path: string }>;
  orphaned: Array<{ id: string; path: string; reason: string }>;
  written: boolean;
};

// One-time fold of the legacy bindings file into manifests. Generic on purpose (the kernel is
// public): a binding becomes a path of `04-projects/<id>/project.json` only when that project
// folder exists; any other binding is reported and left alone, never turned into a new folder.
export async function migrateProjectBindings(
  write: boolean,
): Promise<ProjectMigration> {
  return withProjectsLock(async () => {
    const legacy = await listLegacyBindings();
    const manifests = await listProjectManifests();
    const claimed = new Set(
      manifestBindings(manifests).map((binding) => binding.path),
    );
    const result: ProjectMigration = {
      migrated: [],
      orphaned: [],
      written: write,
    };
    const updates = new Map<string, ProjectManifest>();
    for (const binding of legacy) {
      const resolved = canonicalPath(binding.path);
      if (claimed.has(resolved)) continue;
      if (!isValidProjectId(binding.id)) {
        result.orphaned.push({
          id: binding.id,
          path: resolved,
          reason: "id is not a valid project folder name; bind it explicitly",
        });
        continue;
      }
      const folder = path.join(projectsRoot(), projectFolder(binding.id));
      if (!existsSync(folder)) {
        result.orphaned.push({
          id: binding.id,
          path: resolved,
          reason: `no project folder ${path.relative(oceanRoot(), folder)}; bind it explicitly`,
        });
        continue;
      }
      const base =
        updates.get(binding.id) ??
        manifests.find((manifest) => manifest.id === binding.id) ??
        (await newManifest(
          binding.id,
          {
            name: binding.name || binding.id,
            paths: [],
            created: binding.boundAt || new Date().toISOString(),
            autoRegistered: false,
          },
          [...manifests, ...updates.values()],
        ));
      updates.set(binding.id, {
        ...base,
        paths: [...base.paths, portablePath(resolved)],
      });
      claimed.add(resolved);
      result.migrated.push({ id: binding.id, path: resolved });
    }
    if (write && updates.size) {
      for (const manifest of updates.values()) await writeManifest(manifest);
      await saveProjectBindings(
        cacheBindings(await listProjectManifests(), legacy),
      );
    }
    return result;
  });
}

const INDEX_BEGIN =
  "<!-- ocean:projects:begin (generated by `ocean project index --write`) -->";
const INDEX_END = "<!-- ocean:projects:end -->";

// Generated view of every project.json, kept in a managed block of 04-projects/registry.md so
// the hand-kept rows around it are never rewritten.
export async function renderProjectIndex(): Promise<string> {
  // Table cells: a `|` or a line break in a name or path would split the row.
  const cell = (value: string) =>
    value.replace(/[\r\n]+/g, " ").replaceAll("|", "\\|");
  const rows = (await listProjectManifests()).map(
    (manifest) =>
      `| \`${manifest.id}\` | ${cell(manifest.name)} | ${
        manifest.paths.length
          ? manifest.paths.map((entry) => `\`${cell(entry)}\``).join("<br>")
          : "—"
      } | ${manifest.autoRegistered ? "auto" : "manual"} |`,
  );
  return [
    INDEX_BEGIN,
    "## Projects (from project.json)",
    "",
    "| Project | Name | Paths | Registered |",
    "|---|---|---|---|",
    ...rows,
    INDEX_END,
  ].join("\n");
}

export async function writeProjectIndex(): Promise<{
  file: string;
  changed: boolean;
}> {
  return withProjectsLock(writeProjectIndexLocked);
}

async function writeProjectIndexLocked(): Promise<{
  file: string;
  changed: boolean;
}> {
  const file = path.join(projectsRoot(), "registry.md");
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const block = await renderProjectIndex();
  const begin = existing.indexOf(INDEX_BEGIN);
  const end = existing.indexOf(INDEX_END);
  let next: string;
  if (begin >= 0 && end > begin)
    next = `${existing.slice(0, begin)}${block}${existing.slice(end + INDEX_END.length)}`;
  else if (begin >= 0 || end >= 0)
    throw new Error(
      `${file}: unmatched ocean:projects marker; fix it by hand before regenerating`,
    );
  else
    next = existing
      ? `${existing.replace(/\n*$/, "")}\n\n${block}\n`
      : `# Project registry\n\n${block}\n`;
  if (next === existing) return { file, changed: false };
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, next);
  return { file, changed: true };
}

// Where a session may register its repo as a project without being asked (T-256 phase 2).
// OCEAN_CODE_ROOTS (a PATH-style list) overrides the default, ~/Documents.
export function codeRoots(): string[] {
  const configured = oceanEnv("CODE_ROOTS");
  return (configured ? configured.split(path.delimiter) : ["~/Documents"])
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(expandHome(entry)));
}

export function projectSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64)
    .replace(/[-._]+$/, "");
}

export type AutoRegistration = { resolution: ProjectResolution } & (
  | { status: "registered"; projectId: string; path: string }
  | { status: "skipped"; reason: string }
);

async function realOrSelf(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}

function within(root: string, target: string): boolean {
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target === root || target.startsWith(prefix);
}

class ProjectFolderTaken extends Error {}

// A session opened in a git repo that no project claims registers that repo as its own
// project: 04-projects/<slug>/ with project.json, tasks/ and MEMORY.md. Automatic runs stay
// under the code roots, out of the temp dir and off a code root itself; `explicit` (the
// `ocean project register` command) is the owner asking, so only the hard rules apply: a git
// repo, not a linked worktree or submodule, not the Ocean workspace, never over an existing
// project folder. Sibling repos are never merged: a code-root folder often holds unrelated
// repos, so joining one project to another stays explicit (`bind --add`).
export async function autoRegisterProject(
  cwd: string,
  options: { explicit?: boolean; resolution?: ProjectResolution } = {},
): Promise<AutoRegistration> {
  let resolution = options.resolution ?? (await resolveProject(cwd));
  const skipped = (reason: string): AutoRegistration => ({
    status: "skipped",
    reason,
    resolution,
  });
  if (!options.explicit && oceanEnv("AUTO_REGISTER") === "0")
    return skipped("disabled by OCEAN_AUTO_REGISTER=0");
  if (resolution.status !== "unbound")
    return skipped(`already ${resolution.status}`);
  if (!resolution.gitRoot) return skipped("not inside a git repository");
  if (!statSync(path.join(resolution.gitRoot, ".git")).isDirectory())
    return skipped("a linked worktree or submodule; bind it explicitly");
  const repo = await realOrSelf(resolution.gitRoot);
  if (within(await realOrSelf(oceanRoot()), repo))
    return skipped("inside the Ocean workspace");
  if (!options.explicit) {
    const roots = await Promise.all(codeRoots().map(realOrSelf));
    if (roots.includes(repo)) return skipped("is a code root itself");
    const root = roots.find((candidate) => within(candidate, repo));
    if (!root) return skipped("outside the code roots");
    // The temp dir is excluded unless the owner deliberately put a code root inside it.
    const temp = await realOrSelf(os.tmpdir());
    if (within(temp, repo) && !within(temp, root))
      return skipped("inside the temp directory");
  }
  const id = projectSlug(path.basename(repo));
  if (!isValidProjectId(id)) return skipped(`no usable id from '${repo}'`);
  let result: BindProjectResult;
  try {
    result = await bindProject(id, resolution.gitRoot, {
      autoRegistered: true,
    });
  } catch (error) {
    if (!(error instanceof ProjectFolderTaken)) throw error;
    // Another session may have registered this very repo a moment ago.
    resolution = await resolveProject(cwd);
    return skipped(error.message);
  }
  if (result.conflict) {
    resolution = await resolveProject(cwd);
    return skipped(`conflicts with project '${result.conflict.id}'`);
  }
  const folder = path.join(projectsRoot(), id);
  await mkdir(path.join(folder, "tasks"), { recursive: true });
  try {
    await writeFile(
      path.join(folder, "MEMORY.md"),
      `${memoryHeading(id)}\n\nIndex of this project's memory. Loaded only for sessions in this project.\n`,
      { flag: "wx" },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  resolution = {
    status: "bound",
    projectId: id,
    name: id,
    path: result.binding.path,
    matchedOn: result.binding.path === path.resolve(cwd) ? "cwd" : "path",
    confidence: "high",
  };
  return {
    status: "registered",
    projectId: id,
    path: result.binding.path,
    resolution,
  };
}

function memoryHeading(id: string): string {
  return `# ${id} — memory`;
}

// Undoes a binding (a wrong auto-registration, a moved repo). Only the path goes; the project
// folder and its tasks stay, since deleting them is the owner's call.
export async function unbindProjectPath(
  targetPath: string,
): Promise<{ removed: ProjectBinding | null }> {
  const resolvedPath = canonicalPath(targetPath);
  return withProjectsLock(async () => {
    const manifests = await listProjectManifests();
    const legacy = await listLegacyBindings();
    // The binding whose path contains the given one, longest first, so `unbind .` works from
    // anywhere inside the repo.
    const removed =
      combineBindings(manifests, legacy)
        .filter((binding) => within(path.resolve(binding.path), resolvedPath))
        .sort((a, b) => b.path.length - a.path.length)[0] ?? null;
    if (!removed) return { removed };
    const boundPath = path.resolve(removed.path);
    const owner = manifests.find((manifest) =>
      manifest.paths.some((stored) => canonicalPath(stored) === boundPath),
    );
    if (owner)
      await writeManifest({
        ...owner,
        paths: owner.paths.filter(
          (stored) => canonicalPath(stored) !== boundPath,
        ),
      });
    // A legacy entry for the same path would otherwise take the binding back.
    const keptLegacy = legacy.filter(
      (binding) => canonicalPath(binding.path) !== boundPath,
    );
    await saveProjectBindings(
      cacheBindings(await listProjectManifests(), keptLegacy),
    );
    return { removed };
  });
}

// Renames a project folder (fixes a wrong auto-registered id). Refused while the project has
// tasks: their records carry the project id, and rewriting them belongs to phase 3.
export async function renameProject(
  from: string,
  to: string,
): Promise<{ from: string; to: string }> {
  if (!isValidProjectId(from) || !isValidProjectId(to))
    throw new Error("Project ids must be lowercase letters, digits, . _ or -");
  return withProjectsLock(async () => {
    const source = path.join(projectsRoot(), from);
    const target = path.join(projectsRoot(), to);
    const manifest = (await listProjectManifests()).find(
      (candidate) => candidate.id === from,
    );
    if (!manifest) throw new Error(`No project.json for '${from}'`);
    if (existsSync(target)) throw new Error(`04-projects/${to} already exists`);
    const tasks = await readdir(path.join(source, "tasks")).catch(() => []);
    if (tasks.some((entry) => !entry.startsWith(".")))
      throw new Error(
        `'${from}' has tasks; renaming a project with tasks is not supported yet`,
      );
    await rename(source, target);
    await writeManifest({
      ...manifest,
      id: to,
      name: manifest.name === from ? to : manifest.name,
    });
    const memory = path.join(target, "MEMORY.md");
    try {
      const text = await readFile(memory, "utf8");
      if (text.startsWith(memoryHeading(from)))
        await atomicWrite(
          memory,
          `${memoryHeading(to)}${text.slice(memoryHeading(from).length)}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (
      (
        await readFile(path.join(projectsRoot(), "registry.md"), "utf8").catch(
          () => "",
        )
      ).includes(INDEX_BEGIN)
    )
      await writeProjectIndexLocked();
    await saveProjectBindings(
      cacheBindings(await listProjectManifests(), await listLegacyBindings()),
    );
    return { from, to };
  });
}
