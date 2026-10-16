import type { SessionStorePort } from "@ocean/core/domain/ports/session-store-port.js";
import { folderProject } from "../../shared/project-resolution.js";

export type SessionProjectBackfill = {
  sessions: number;
  handoffs: number;
  unresolved: number;
};

// The project to record on a new session. Recording a session must not fail on registry state,
// so an unreadable registry yields null; the next `ocean migrate --apply` fills it.
export async function sessionProjectId(cwd: string): Promise<string | null> {
  try {
    return await folderProject(cwd);
  } catch {
    return null;
  }
}

// Fill project_id on sessions recorded before the column existed, then on the handoffs that
// came from them. An unreadable registry throws and aborts: never guess a folder's project.
export async function backfillSessionProjects(
  store: SessionStorePort,
): Promise<SessionProjectBackfill> {
  let sessions = 0;
  let unresolved = 0;
  for (const directory of store.sessionDirectoriesMissingProject()) {
    const project = await folderProject(directory);
    if (project) sessions += store.setProjectForDirectory(directory, project);
    else unresolved += 1;
  }
  return { sessions, handoffs: store.backfillHandoffProjects(), unresolved };
}
