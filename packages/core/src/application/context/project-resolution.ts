import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { atomicWrite, registryFile, withFileLock } from "../../fs-utils.js";
import {
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

// A project id names a folder under 04-projects, so it must be one plain path segment.
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidProjectId(value: string): boolean {
  return PROJECT_ID.test(value) && !value.includes("..");
}

function projectsRoot(): string {
  return oceanPath(PROJECTS_DIR);
}

function manifestPath(projectId: string): string {
  return path.join(projectsRoot(), projectFolder(projectId), MANIFEST_FILE);
}

function parseManifest(file: string, folder: string, raw: string) {
  const parsed = JSON.parse(raw) as Partial<ProjectManifest>;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray(parsed.paths) ||
    parsed.paths.some((entry) => typeof entry !== "string" || !entry.trim())
  )
    throw new Error(
      `Invalid project manifest (paths must be strings): ${file}`,
    );
  // The folder name is the id; a manifest cannot claim another project's identity.
  return {
    id: folder,
    name: typeof parsed.name === "string" && parsed.name ? parsed.name : folder,
    paths: parsed.paths,
    created: typeof parsed.created === "string" ? parsed.created : "",
    autoRegistered: parsed.autoRegistered === true,
  } satisfies ProjectManifest;
}

export async function listProjectManifests(): Promise<ProjectManifest[]> {
  let folders: string[];
  try {
    folders = (await readdir(projectsRoot(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const manifests: ProjectManifest[] = [];
  for (const folder of folders) {
    const file = path.join(projectsRoot(), folder, MANIFEST_FILE);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    manifests.push(parseManifest(file, folder, raw));
  }
  return manifests;
}

async function writeManifest(manifest: ProjectManifest): Promise<void> {
  const file = manifestPath(manifest.id);
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

// Bindings recorded before T-256, read from the flat registry file. Kept as a fallback until
// `ocean project migrate --write` folds them into manifests, and rewritten as a cache after
// every manifest change for anything that still reads the file.
async function listLegacyBindings(): Promise<ProjectBinding[]> {
  try {
    const raw = await readFile(bindingsFile(), "utf8");
    const parsed = JSON.parse(raw) as {
      version: number;
      bindings: ProjectBinding[];
    };
    return (parsed.bindings ?? []).filter((binding) => !binding.manifest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function manifestBindings(manifests: ProjectManifest[]): ProjectBinding[] {
  return manifests.flatMap((manifest) =>
    manifest.paths.map((stored) => {
      const resolved = path.resolve(expandHome(stored));
      return {
        id: manifest.id,
        name: manifest.name,
        path: resolved,
        gitRoot: findGitRoot(resolved),
        boundAt: manifest.created,
        manifest: true,
      };
    }),
  );
}

export async function listProjectBindings(): Promise<ProjectBinding[]> {
  const fromManifests = manifestBindings(await listProjectManifests());
  const claimed = new Set(fromManifests.map((binding) => binding.path));
  const legacy = (await listLegacyBindings()).filter(
    (binding) => !claimed.has(path.resolve(binding.path)),
  );
  return [...fromManifests, ...legacy];
}

async function saveProjectBindings(bindings: ProjectBinding[]): Promise<void> {
  const file = bindingsFile();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.ocean-tmp-${process.pid}`;
  await writeFile(
    tmp,
    `${JSON.stringify({ version: 1, bindings }, null, 2)}\n`,
    "utf8",
  );
  await rename(tmp, file);
}

// One lock for every manifest/cache write: bindings are checked across all projects (a path
// may belong to one project only), so per-project locks would let two writers both pass.
function withProjectsLock<T>(run: () => Promise<T>): Promise<T> {
  return withFileLock(bindingsFile(), run);
}

// Resolves the active Ocean project from a working directory: no terminal-in-Ocean
// requirement. Match order is git root, then the exact cwd, then (as a last resort) whether
// the path is inside the Ocean workspace root itself, which is always the workspace project.
export async function resolveProject(cwd: string): Promise<ProjectResolution> {
  const resolvedCwd = path.resolve(cwd);
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

  const root = oceanRoot();
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
      `Invalid project id '${name}': use letters, digits, dot, underscore or hyphen`,
    );
  const resolvedPath = path.resolve(expandHome(targetPath));
  return withProjectsLock(async () => {
    const bindings = await listProjectBindings();
    const existingAtPath = bindings.find(
      (binding) => path.resolve(binding.path) === resolvedPath,
    );
    if (existingAtPath) {
      if (existingAtPath.id === name && existingAtPath.manifest)
        return { binding: existingAtPath, created: false };
      if (existingAtPath.id !== name)
        return {
          binding: existingAtPath,
          created: false,
          conflict: existingAtPath,
        };
    }
    const manifests = await listProjectManifests();
    const existing = manifests.find((manifest) => manifest.id === name);
    const existingByName = bindings.find(
      (binding) => binding.id === name && binding.path !== resolvedPath,
    );
    if (existingByName && !options.addPath)
      return {
        binding: existingByName,
        created: false,
        conflict: existingByName,
      };
    const manifest: ProjectManifest = existing
      ? {
          ...existing,
          paths: [...existing.paths, portablePath(resolvedPath)],
        }
      : {
          id: name,
          name,
          paths: [portablePath(resolvedPath)],
          created: new Date().toISOString(),
          autoRegistered: options.autoRegistered === true,
        };
    await writeManifest(manifest);
    await saveProjectBindings(await listProjectBindings());
    const binding = (await listProjectBindings()).find(
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
      const resolved = path.resolve(binding.path);
      if (claimed.has(resolved)) continue;
      const folder = path.join(projectsRoot(), projectFolder(binding.id));
      if (!existsSync(folder)) {
        result.orphaned.push({
          id: binding.id,
          path: resolved,
          reason: `no project folder ${path.relative(oceanRoot(), folder)}; bind it explicitly`,
        });
        continue;
      }
      const base = updates.get(binding.id) ??
        manifests.find((manifest) => manifest.id === binding.id) ?? {
          id: binding.id,
          name: binding.name || binding.id,
          paths: [],
          created: binding.boundAt || new Date().toISOString(),
          autoRegistered: false,
        };
      updates.set(binding.id, {
        ...base,
        paths: [...base.paths, portablePath(resolved)],
      });
      claimed.add(resolved);
      result.migrated.push({ id: binding.id, path: resolved });
    }
    if (write && updates.size) {
      for (const manifest of updates.values()) await writeManifest(manifest);
      await saveProjectBindings(await listProjectBindings());
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
  const rows = (await listProjectManifests()).map(
    (manifest) =>
      `| \`${manifest.id}\` | ${manifest.name} | ${
        manifest.paths.length
          ? manifest.paths.map((entry) => `\`${entry}\``).join("<br>")
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
