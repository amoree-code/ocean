import os from "node:os";
import path from "node:path";
import type { Placement } from "@ocean/brain/memory/memory-harvest.js";
import {
  expandHome,
  listProjectManifests,
  projectFormerPaths,
  projectTags,
} from "@ocean/core/shared/project-resolution.js";

// Which of the owner's projects a pulled conversation or memory belongs to (T-305), so a pull
// lands sorted instead of in one pile. A folder matches the project bound to it or to a folder
// it lived in before (`formerPaths`), else a folder named like the project wherever it sits now.
// Home, the filesystem root and temporary or scratch folders are `scratch`; anything else is
// `unassigned` — still pulled and indexed, listed for the owner to bind, never dropped.

export type ProjectIndex = {
  projects: {
    id: string;
    names: string[];
    tags: string[];
    folders: string[];
  }[];
  home: string;
};

export const UNASSIGNED = "unassigned";
export const SCRATCH = "scratch";

const lower = (value: string) => value.toLowerCase();

export async function loadProjectIndex(
  home = os.homedir(),
): Promise<ProjectIndex> {
  const projects = [];
  for (const manifest of await listProjectManifests()) {
    // A malformed optional list must not drop the project from sorting.
    const safe = <T>(read: () => T[]) => {
      try {
        return read();
      } catch {
        return [];
      }
    };
    const former = safe(() => projectFormerPaths(manifest));
    const folders = [...manifest.paths, ...former].map((entry) =>
      path.resolve(expandHome(entry)),
    );
    projects.push({
      id: manifest.id,
      // A project is also known by its old folders' names (atlas for ocean) — not by its
      // current folders' names, which can be as generic as `dashboard`.
      names: [
        ...new Set(
          [
            manifest.id,
            manifest.name,
            ...former.map((entry) => path.basename(expandHome(entry))),
          ]
            .filter(Boolean)
            .map(lower),
        ),
      ],
      tags: safe(() => projectTags(manifest)),
      folders,
    });
  }
  return { projects, home };
}

// macOS folder names ignore case: ~/Documents/ameer/Ocean-UIUX-MCP is the bound ocean-UIUX-MCP.
const within = (folder: string, root: string) =>
  lower(folder) === lower(root) || lower(folder).startsWith(`${lower(root)}/`);

function isScratch(folder: string, home: string): boolean {
  const roots = [
    os.tmpdir(),
    "/tmp",
    "/private/tmp",
    "/var/folders",
    "/private/var/folders",
    path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "scratch-workspaces",
    ),
  ];
  return (
    folder === "/" ||
    folder === home ||
    roots.some((root) => folder === root || folder.startsWith(`${root}/`)) ||
    /(^|[-_/])scratch([-_/]|$)/i.test(path.basename(folder))
  );
}

// A conversation's working folder → its project.
export function placeFolder(
  index: ProjectIndex,
  cwd: string | undefined,
): Placement {
  if (!cwd) return { project: UNASSIGNED };
  const folder = path.resolve(expandHome(cwd.trim()));
  const shown = folder.startsWith(index.home)
    ? `~${folder.slice(index.home.length)}`
    : folder;
  let best: { id: string; tags: string[]; length: number } | undefined;
  for (const project of index.projects)
    for (const root of project.folders)
      if (within(folder, root) && root.length > (best?.length ?? -1))
        best = { id: project.id, tags: project.tags, length: root.length };
  if (best)
    return { project: best.id, tags: best.tags, cwd: shown, target: true };
  if (isScratch(folder, index.home)) return { project: SCRATCH, cwd: shown };
  // The deepest folder on the path named like a project (moved folders keep their names).
  for (const part of folder.split(path.sep).filter(Boolean).reverse()) {
    const project = index.projects.find((item) =>
      item.names.includes(lower(part.trim())),
    );
    if (project)
      return {
        project: project.id,
        tags: project.tags,
        cwd: shown,
        target: true,
      };
  }
  return { project: UNASSIGNED, cwd: shown };
}

// The project whose name appears in a phrase as whole words; the longest name wins, so
// "Ocean IELTS plan" is ocean-ielts, not ocean.
const words = (value: string) =>
  `-${value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}-`;
function projectNamedIn(index: ProjectIndex, phrase: string) {
  const text = words(phrase);
  return index.projects
    .flatMap((project) =>
      project.names.map((name) => ({ project, name: words(name) })),
    )
    .filter(({ name }) => name !== "--" && text.includes(name))
    .sort((a, b) => b.name.length - a.name.length)[0]?.project;
}

// Claude Code names a project's folder by its path with every non-alphanumeric as `-`.
const claudeDir = (folder: string) => folder.replace(/[^A-Za-z0-9]/g, "-");

// A memory text → its project: Claude Code's per-project memory by its folder, a claude.ai
// project by its name, anything else by a project named in its first heading.
export function placeMemory(
  index: ProjectIndex,
  origin: { client: string; file: string; text: string; name?: string },
): Placement {
  if (origin.client === "claude-code") {
    const dir = /\.claude\/projects\/([^/]+)\/memory\//.exec(origin.file)?.[1];
    if (dir) {
      let best: { id: string; tags: string[]; length: number } | undefined;
      for (const project of index.projects)
        for (const root of project.folders) {
          const encoded = claudeDir(root);
          if (
            (lower(dir) === lower(encoded) ||
              lower(dir).startsWith(`${lower(encoded)}-`)) &&
            encoded.length > (best?.length ?? -1)
          )
            best = {
              id: project.id,
              tags: project.tags,
              length: encoded.length,
            };
        }
      if (best) return { project: best.id, tags: best.tags, target: true };
      return { project: UNASSIGNED };
    }
  }
  const named = origin.name ?? /^#{1,6}\s+(.+)$/m.exec(origin.text)?.[1];
  const project = named ? projectNamedIn(index, named) : undefined;
  if (project) return { project: project.id, tags: project.tags, target: true };
  // Global memory and instructions are about the owner, not one project.
  return { project: "personal" };
}
