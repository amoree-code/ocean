import { access, readFile, rename } from "node:fs/promises";
import path from "node:path";
import {
  formatTaskId,
  isValidPrefix,
  LEGACY_PREFIX,
  parseTaskId,
} from "@ocean/core/domain/tasks/task-id.js";
import { atomicWrite } from "../../fs-utils.js";
import {
  isWorkspaceProject,
  oceanRoot,
  PROJECTS_DIR,
  WORKSPACE_PROJECT_ID,
} from "../../paths.js";
import {
  highestTaskNumber,
  listProjectManifests,
  withProjectsLock,
  writeManifest,
} from "../context/project-resolution.js";
import { taskFolders } from "./task-reference.js";

export type RenumberMove = { from: string; to: string; archived: boolean };

export type RenumberResult = {
  dryRun: boolean;
  project: string;
  prefix: string;
  moves: RenumberMove[];
  nextTask: number;
};

// Moves a project's tasks from the shared T namespace to its own prefix (T-256): T-300 becomes
// OL-001, and the record keeps `legacyId: T-300` so every old reference still resolves. Dry run
// unless `write`. Idempotent: a task already under the prefix keeps its number, so a rerun only
// picks up what is new.
export async function renumberTasks(options: {
  project: string;
  prefix: string;
  write?: boolean;
}): Promise<RenumberResult> {
  const { project, prefix } = options;
  if (isWorkspaceProject(project))
    throw new Error(
      `${project} is the workspace project and keeps the ${LEGACY_PREFIX} namespace`,
    );
  if (prefix === LEGACY_PREFIX || !isValidPrefix(prefix))
    throw new Error(
      `'${prefix}' is not a usable prefix: 1-6 upper-case letters or digits, starting with a letter, and not a reserved word`,
    );
  return withProjectsLock(async () => {
    const manifests = await listProjectManifests();
    const ocean = manifests.find(
      (manifest) => manifest.id === WORKSPACE_PROJECT_ID,
    );
    if (!ocean)
      throw new Error(
        "no project.json for the workspace project; run `ocean project migrate --write` first",
      );
    const manifest = manifests.find((candidate) => candidate.id === project);
    if (!manifest)
      throw new Error(
        `no project.json for '${project}'; bind it before renumbering`,
      );
    const claimant = manifests.find(
      (candidate) => candidate.prefix === prefix && candidate.id !== project,
    );
    if (claimant)
      throw new Error(`prefix ${prefix} is already used by ${claimant.id}`);
    if (manifest.prefix && manifest.prefix !== prefix)
      throw new Error(`${project} already uses prefix ${manifest.prefix}`);

    const projectsDir = path.join(oceanRoot(), PROJECTS_DIR);
    type Entry = {
      folder: string;
      file: string;
      archived: boolean;
      oldId: string;
      declared: number | null;
      source: string;
    };
    const entries: Entry[] = [];
    for (const [folder, file, archived] of await taskFolders(
      projectsDir,
      project,
    )) {
      let source: string;
      try {
        source = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const head = source.slice(0, Math.max(source.indexOf("\n---", 4), 0));
      const field = (name: string) =>
        head.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim();
      const declared = parseTaskId(field("id") ?? "");
      const oldId = field("legacyId") ?? folder;
      if (!parseTaskId(oldId)) continue;
      entries.push({
        folder,
        file,
        archived,
        oldId,
        declared: declared?.prefix === prefix ? declared.number : null,
        source,
      });
    }
    // Tasks already under the prefix keep their number; the rest are numbered after them, in
    // the order of their old ids.
    const kept = entries.filter((entry) => entry.declared !== null);
    let counter = Math.max(0, ...kept.map((entry) => entry.declared ?? 0));
    const pending = entries
      .filter((entry) => entry.declared === null)
      .sort(
        (a, b) =>
          (parseTaskId(a.oldId)?.number ?? 0) -
          (parseTaskId(b.oldId)?.number ?? 0),
      );
    const targets = new Map<Entry, string>();
    for (const entry of kept)
      targets.set(entry, formatTaskId(prefix, entry.declared as number));
    for (const entry of pending) {
      counter += 1;
      targets.set(entry, formatTaskId(prefix, counter));
    }
    const moves: Array<Entry & { to: string }> = [];
    for (const entry of entries) {
      const to = targets.get(entry) as string;
      if (to === entry.folder && entry.declared !== null) continue;
      moves.push({ ...entry, to });
    }
    moves.sort((a, b) => a.to.localeCompare(b.to));
    for (const move of moves) {
      const destination = path.join(
        path.dirname(path.dirname(move.file)),
        move.to,
      );
      if (move.to !== move.folder && (await exists(destination)))
        throw new Error(
          `${path.relative(oceanRoot(), destination)} already exists; resolve it before renumbering`,
        );
    }
    const nextTask = Math.max(manifest.nextTask ?? 1, counter + 1);
    const result: RenumberResult = {
      dryRun: !options.write,
      project,
      prefix,
      moves: moves.map(({ folder, to, archived }) => ({
        from: folder,
        to,
        archived,
      })),
      nextTask,
    };
    if (!options.write) return result;

    // Every record is rewritten in memory first, so one without an id in its frontmatter
    // refuses the run before anything is written. Only the frontmatter changes.
    const rewritten = moves.map((move) => {
      const end = move.source.indexOf("\n---", 4);
      if (
        !move.source.startsWith("---\n") ||
        end < 0 ||
        !/^id:/m.test(move.source.slice(0, end))
      )
        throw new Error(
          `${path.relative(oceanRoot(), move.file)} has no id in its frontmatter`,
        );
      let head = move.source
        .slice(0, end)
        .replace(/^id:.*$/m, `id: ${move.to}`);
      if (!/^legacyId:/m.test(head))
        head = head.replace(
          /^id:.*$/m,
          (line) => `${line}\nlegacyId: ${move.oldId}`,
        );
      return { move, source: head + move.source.slice(end) };
    });

    // The T counter first: once these tasks leave the shared namespace the scan no longer sees
    // their numbers, and no project on T may reissue them.
    const globalMax = await highestTaskNumber(LEGACY_PREFIX);
    await writeManifest({
      ...ocean,
      nextTask: Math.max(ocean.nextTask ?? 1, globalMax + 1),
    });
    // The prefix next, before any move: if a move fails, the ids already moved still resolve,
    // and a rerun finishes the rest.
    await writeManifest({ ...manifest, prefix, nextTask });
    for (const { move, source } of rewritten) {
      await atomicWrite(move.file, source);
      if (move.to !== move.folder)
        await rename(
          path.dirname(move.file),
          path.join(path.dirname(path.dirname(move.file)), move.to),
        );
    }
    return result;
  });
}

async function exists(target: string): Promise<boolean> {
  return access(target).then(
    () => true,
    () => false,
  );
}
