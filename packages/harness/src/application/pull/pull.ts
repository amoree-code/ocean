import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  type Classify,
  type HarvestItem,
  harvestMemory,
  importClaudeExport,
} from "@ocean/brain/memory/memory-harvest.js";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { buildHistoryIndex } from "./history-index.js";
import { loadProjectIndex, placeMemory } from "./project-match.js";

// `ocean pull` (T-305): one command brings everything every AI client on this machine holds into
// Ocean — each client's own memory and the instruction files the owner wrote (as candidates for
// review, never straight into memory), a claude.ai export found in ~/Downloads (its projects, as
// candidates too), and an index of every conversation (pointers only, transcripts stay put).
// Everything pulled is sorted by the owner's projects and carries where it came from (client,
// project, file, date). Nothing is pulled twice (content keys, also across spacing and case) and
// nothing is lost: every item read is listed in the run's record with what happened to it.
// A dry run until --yes. `--daily` returns at once when the last pull is under a day old, so the
// session-start hook can run it every time.

const DAY_MS = 24 * 60 * 60 * 1000;
const stampFile = () => oceanPath(SYSTEM_DIR, "state", "pull", "last.json");
const importsDir = () => oceanPath(SYSTEM_DIR, "state", "imports");
export const runsDir = () => oceanPath(SYSTEM_DIR, "state", "pull", "runs");

export type ExportFound = {
  path: string;
  kind: "folder" | "zip";
  items?: number;
  new?: number;
  problems?: string[];
  // Files in the export the importer does not read yet, by name only.
  unread?: string[];
};

type Counts = Partial<Record<HarvestItem["status"], number>>;

export type PullResult = {
  applied: boolean;
  skipped?: string;
  memory?: Record<string, Counts>;
  exports?: ExportFound[];
  history?: Record<string, number>;
  // project → memory by status and conversations by client.
  projects?: Record<
    string,
    { memory: Counts; history: Record<string, number> }
  >;
  // Conversation folders no project claims, most used first, to bind or ignore.
  unassignedFolders?: { folder: string; conversations: number }[];
  record?: string;
};

function tally(items: HarvestItem[]): PullResult["memory"] {
  const counts: NonNullable<PullResult["memory"]> = {};
  for (const item of items) {
    const bySource = counts[item.source] ?? {};
    bySource[item.status] = (bySource[item.status] ?? 0) + 1;
    counts[item.source] = bySource;
  }
  return counts;
}

const exists = (target: string) =>
  stat(target).then(
    () => true,
    () => false,
  );

// claude.ai exports in ~/Downloads: an unpacked folder holding projects.json, or the zip it came
// in (`data-….zip`), which --yes unpacks once into the workspace's state folder.
async function findExports(home: string): Promise<ExportFound[]> {
  const downloads = path.join(home, "Downloads");
  const entries = await readdir(downloads, { withFileTypes: true }).catch(
    () => [],
  );
  const found: ExportFound[] = [];
  for (const entry of entries) {
    const target = path.join(downloads, entry.name);
    if (
      entry.isDirectory() &&
      (await exists(path.join(target, "projects.json")))
    )
      found.push({ path: target, kind: "folder" });
    else if (entry.isFile() && /^data-.*\.zip$/i.test(entry.name))
      found.push({ path: target, kind: "zip" });
  }
  return found;
}

async function unpack(zip: string): Promise<string> {
  const target = path.join(importsDir(), path.basename(zip, ".zip"));
  if (!(await exists(target))) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    await promisify(execFile)("unzip", ["-o", "-q", zip, "-d", target]);
  }
  return target;
}

async function importExport(
  found: ExportFound,
  apply: boolean,
  classify: Classify,
): Promise<{ found: ExportFound; items: HarvestItem[] }> {
  if (found.kind === "zip" && !apply) return { found, items: [] };
  const folder = found.kind === "zip" ? await unpack(found.path) : found.path;
  const { items, problems } = await importClaudeExport(folder, {
    apply,
    classify,
  });
  const names = await readdir(folder).catch(() => []);
  return {
    items,
    found: {
      ...found,
      items: items.length,
      new: items.filter(
        (item) => item.status === "new" || item.status === "proposed",
      ).length,
      ...(problems.length ? { problems } : {}),
      unread: names.filter(
        (name) => name !== "projects.json" && !name.startsWith("."),
      ),
    },
  };
}

export async function pull(
  options: { apply?: boolean; daily?: boolean; home?: string } = {},
): Promise<PullResult> {
  const apply = Boolean(options.apply);
  const home = options.home ?? os.homedir();
  if (options.daily) {
    const last = JSON.parse(
      await readFile(stampFile(), "utf8").catch(() => "{}"),
    ) as { at?: string };
    const age = Date.now() - Date.parse(last.at ?? "");
    if (age < DAY_MS)
      return { applied: false, skipped: `last pull ${last.at}` };
  }
  const projects = await loadProjectIndex(home);
  const classify: Classify = (origin) => placeMemory(projects, origin);
  const items = await harvestMemory({ apply, home, classify });
  const exports: ExportFound[] = [];
  for (const found of await findExports(home)) {
    const imported = await importExport(found, apply, classify);
    exports.push(imported.found);
    items.push(...imported.items);
  }
  const conversations = await buildHistoryIndex({ home, write: apply });
  const history: Record<string, number> = {};
  const byProject: NonNullable<PullResult["projects"]> = {};
  const slot = (id: string) => {
    byProject[id] ??= { memory: {}, history: {} };
    return byProject[id];
  };
  for (const item of items) {
    const counts = slot(item.project ?? "unassigned").memory;
    counts[item.status] = (counts[item.status] ?? 0) + 1;
  }
  const loose = new Map<string, number>();
  for (const entry of conversations) {
    history[entry.client] = (history[entry.client] ?? 0) + 1;
    const counts = slot(entry.project).history;
    counts[entry.client] = (counts[entry.client] ?? 0) + 1;
    if (entry.project === "unassigned" && entry.cwd)
      loose.set(entry.cwd, (loose.get(entry.cwd) ?? 0) + 1);
  }
  const result: PullResult = {
    applied: apply,
    memory: tally(items),
    exports,
    history,
    projects: byProject,
    unassignedFolders: [...loose]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([folder, count]) => ({ folder, conversations: count })),
  };
  if (apply) {
    // The run's record: every item read and what became of it.
    const at = new Date().toISOString();
    const record = path.join(runsDir(), `${at.replace(/[:.]/g, "-")}.json`);
    await mkdir(runsDir(), { recursive: true, mode: 0o700 });
    await writeFile(
      record,
      `${JSON.stringify({ at, ...result, items }, null, 2)}\n`,
      { mode: 0o600 },
    );
    result.record = path.relative(oceanPath(), record);
    await mkdir(path.dirname(stampFile()), { recursive: true, mode: 0o700 });
    await writeFile(
      stampFile(),
      `${JSON.stringify({ at: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
  }
  return result;
}

// The newest run's record, for `ocean pull report`.
export async function lastPullRecord(): Promise<unknown> {
  const runs = (await readdir(runsDir()).catch(() => [])).filter((name) =>
    name.endsWith(".json"),
  );
  const last = runs.sort().at(-1);
  return last
    ? JSON.parse(await readFile(path.join(runsDir(), last), "utf8"))
    : null;
}
