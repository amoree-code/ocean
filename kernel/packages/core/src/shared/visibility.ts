import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "./fs-utils.js";
import { oceanPath, SYSTEM_DIR } from "./paths.js";

// VISIBILITY (T-328 phase 3): the owner can see Ocean is on without asking. A start hook notes
// which Ocean project each folder resolved to, and `ocean client sync` notes when it last ran.
// Status lines read this one small file with jq instead of starting the CLI on every refresh.
// It holds folder paths, project ids and timestamps only — never memory content.

export const VISIBILITY_MAX_FOLDERS = 50;

export type VisibilityState = {
  // Folder (the hook's cwd) → its Ocean project and when a session last started there.
  folders: Record<string, { project: string; at: string }>;
  // When `ocean client sync` last finished.
  syncedAt?: string;
};

export function visibilityFile(): string {
  return oceanPath(SYSTEM_DIR, "state", "visibility.json");
}

export function connectedLine(project: string): string {
  return `🌊 Ocean connected: ${project}`;
}

export async function readVisibility(): Promise<VisibilityState> {
  try {
    const value = JSON.parse(await readFile(visibilityFile(), "utf8"));
    const folders =
      value?.folders && typeof value.folders === "object"
        ? (value.folders as VisibilityState["folders"])
        : {};
    return {
      folders,
      ...(typeof value?.syncedAt === "string"
        ? { syncedAt: value.syncedAt }
        : {}),
    };
  } catch {
    return { folders: {} };
  }
}

// Never throws: a session starts and a sync finishes whether or not this could be noted.
async function updateVisibility(
  change: (state: VisibilityState) => VisibilityState,
): Promise<void> {
  const file = visibilityFile();
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await withFileLock(file, async () => {
      const next = change(await readVisibility());
      await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, {
        mode: 0o600,
      });
    });
  } catch {
    // the next start or sync tries again
  }
}

export async function recordConnected(
  cwd: string,
  project: string,
  now = new Date(),
): Promise<void> {
  const folder = path.resolve(cwd);
  await updateVisibility((state) => {
    const folders = { ...state.folders };
    delete folders[folder];
    folders[folder] = { project, at: now.toISOString() };
    // Newest last; keep only the most recent folders so the file stays small.
    const kept = Object.entries(folders)
      .sort(([, a], [, b]) => a.at.localeCompare(b.at))
      .slice(-VISIBILITY_MAX_FOLDERS);
    return { ...state, folders: Object.fromEntries(kept) };
  });
}

export async function recordSynced(now = new Date()): Promise<void> {
  await updateVisibility((state) => ({
    ...state,
    syncedAt: now.toISOString(),
  }));
}
