import type { SessionStorePort } from "@ocean/core/domain/ports/session-store-port.js";
import {
  NO_PROJECT,
  PROJECT_IDENTITY_EVENT,
  type ProjectDecision,
} from "@ocean/core/domain/sessions/session-identity.js";
import {
  folderProject,
  projectDecision,
  resolveProject,
} from "@ocean/core/shared/project-resolution.js";

export type SessionProjectBackfill = {
  sessions: number;
  handoffs: number;
  unresolved: number;
};

// The project to record on a new session. Recording a session must not fail on registry state,
// so an unreadable registry yields null; the next `ocean migrate --apply` fills it.
export async function sessionProjectId(cwd: string): Promise<string | null> {
  return (await sessionProjectDecision(cwd)).projectId || null;
}

// The project and how it was decided, once, when the session is created (T-331).
export async function sessionProjectDecision(
  cwd: string,
): Promise<ProjectDecision> {
  try {
    return projectDecision(await resolveProject(cwd));
  } catch {
    return NO_PROJECT;
  }
}

// Records how the session's project was decided, so writers read it instead of recomputing.
export function recordProjectDecision(
  store: SessionStorePort,
  sessionId: string,
  decision: ProjectDecision,
): void {
  if (decision.projectId)
    store.appendEvent(
      sessionId,
      PROJECT_IDENTITY_EVENT,
      JSON.stringify(decision),
    );
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
