import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  oceanPath,
  PROJECTS_DIR,
  projectFolder,
  WORKSPACE_PROJECT_ID,
} from "../../paths.js";
import { appendConflict, contentHash } from "./conflict-log.js";
import type { ObsidianConnection } from "./vault-discovery.js";
import type { ObsidianSyncResult } from "./vault-sync.js";

export type VaultIngestionResult = {
  inbox: string[];
  promotionCandidates: string[];
  conflicts: string[];
  removed: string[];
};

function isInbox(file: string): boolean {
  return file === "00-Inbox" || file.startsWith("00-Inbox/");
}
function isPromotionArea(file: string): boolean {
  return ["02-Areas/", "03-Resources/", "05-Goals/"].some((root) =>
    file.startsWith(root),
  );
}
// The workspace project's mirror in the vault: 01-Projects/Ocean(.md|/).
const PROJECT_MIRRORS = ["Ocean"] as const;

function projectMirror(file: string): { relative: string } | null {
  for (const name of PROJECT_MIRRORS) {
    if (file === `01-Projects/${name}.md`) return { relative: "README.md" };
    const prefix = `01-Projects/${name}/`;
    if (file.startsWith(prefix)) return { relative: file.slice(prefix.length) };
  }
  return null;
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function ingestVaultChanges(
  connection: ObsidianConnection,
  result: ObsidianSyncResult,
  stateFile?: string,
  baselineState?: Record<string, { sha256: string }>,
): Promise<VaultIngestionResult> {
  const state = stateFile
    ? (JSON.parse(await readFile(stateFile, "utf8")) as {
        notes?: Record<string, { sha256: string }>;
      })
    : { notes: baselineState ?? {} };
  const baseline = state.notes ?? {};
  const changed = [...result.added, ...result.changed];
  const output: VaultIngestionResult = {
    inbox: [],
    promotionCandidates: [],
    conflicts: [],
    removed: [...result.removed],
  };
  const seenMirrors = new Set<string>();
  for (const relative of changed) {
    if (isInbox(relative)) {
      output.inbox.push(relative);
      continue;
    }
    if (isPromotionArea(relative)) {
      output.promotionCandidates.push(relative);
      continue;
    }
    const mirror = projectMirror(relative);
    if (!mirror) continue;
    if (seenMirrors.has(mirror.relative)) continue;
    seenMirrors.add(mirror.relative);
    const vaultContent = await readOptional(
      path.join(connection.vaultPath, relative),
    );
    const oceanFile = oceanPath(
      PROJECTS_DIR,
      projectFolder(WORKSPACE_PROJECT_ID),
      mirror.relative,
    );
    const oceanContent = await readOptional(oceanFile);
    const record = await appendConflict({
      path: relative,
      baselineSha256: baseline[relative]?.sha256 ?? null,
      vaultSha256: contentHash(vaultContent),
      oceanSha256: contentHash(oceanContent),
      vaultContent,
      oceanContent,
      source: "vault-ingestion",
    });
    output.conflicts.push(record);
  }
  return output;
}
