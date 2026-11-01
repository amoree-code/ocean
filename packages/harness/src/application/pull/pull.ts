import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  type HarvestItem,
  harvestMemory,
  importClaudeExport,
} from "@ocean/brain/memory/memory-harvest.js";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { buildHistoryIndex } from "./history-index.js";

// `ocean pull` (T-305): one command brings everything every AI client on this machine holds into
// Ocean — each client's own memory and the instruction files the owner wrote (as candidates for
// review, never straight into memory), a claude.ai export found in ~/Downloads (its projects, as
// candidates too), and an index of every conversation (pointers only, transcripts stay put).
// A dry run until --yes. `--daily` returns at once when the last pull is under a day old, so the
// session-start hook can run it every time.

const DAY_MS = 24 * 60 * 60 * 1000;
const stampFile = () => oceanPath(SYSTEM_DIR, "state", "pull", "last.json");
const importsDir = () => oceanPath(SYSTEM_DIR, "state", "imports");

export type ExportFound = {
  path: string;
  kind: "folder" | "zip";
  items?: number;
  new?: number;
  problems?: string[];
  // Files in the export the importer does not read yet, by name only.
  unread?: string[];
};

export type PullResult = {
  applied: boolean;
  skipped?: string;
  memory?: Record<string, Partial<Record<HarvestItem["status"], number>>>;
  exports?: ExportFound[];
  history?: Record<string, number>;
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
): Promise<ExportFound> {
  if (found.kind === "zip" && !apply) return found;
  const folder = found.kind === "zip" ? await unpack(found.path) : found.path;
  const { items, problems } = await importClaudeExport(folder, { apply });
  const names = await readdir(folder).catch(() => []);
  return {
    ...found,
    items: items.length,
    new: items.filter(
      (item) => item.status === "new" || item.status === "proposed",
    ).length,
    ...(problems.length ? { problems } : {}),
    unread: names.filter(
      (name) => name !== "projects.json" && !name.startsWith("."),
    ),
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
  const memory = tally(await harvestMemory({ apply, home }));
  const exports: ExportFound[] = [];
  for (const found of await findExports(home))
    exports.push(await importExport(found, apply));
  const history: Record<string, number> = {};
  for (const entry of await buildHistoryIndex({ home, write: apply }))
    history[entry.client] = (history[entry.client] ?? 0) + 1;
  if (apply) {
    await mkdir(path.dirname(stampFile()), { recursive: true, mode: 0o700 });
    await writeFile(
      stampFile(),
      `${JSON.stringify({ at: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
  }
  return { applied: apply, memory, exports, history };
}
