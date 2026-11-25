import type { Session, SessionEvent } from "./session.js";

// The project a session belongs to is decided once, deterministically, before any model runs
// (T-330); every record writer reads that decision and none recomputes it. The store's
// project_id holds the project; this event, appended when the session is created, says how it
// was decided.
export const PROJECT_IDENTITY_EVENT = "project_identity";

// Order of evidence, first hit wins.
export type ProjectHow =
  | "explicit"
  | "project-folder"
  | "path"
  | "git-root"
  | "claude-project"
  | "model"
  // Set by `ocean sessions relink` (T-337) on an old record whose project it decided after the
  // fact; never recorded as an identity event.
  | "backfill"
  | "none";

export type ProjectConfidence = "high" | "medium" | "low" | "none";

export type ProjectDecision = {
  projectId: string;
  how: ProjectHow;
  confidence: ProjectConfidence;
};

export type SessionIdentity = ProjectDecision & { taskId: string };

export const NO_PROJECT: ProjectDecision = {
  projectId: "",
  how: "none",
  confidence: "none",
};

const HOWS: readonly string[] = [
  "explicit",
  "project-folder",
  "path",
  "git-root",
  "claude-project",
  "model",
];
const CONFIDENCES: readonly string[] = ["high", "medium", "low"];

function decisionFrom(data: string): ProjectDecision | null {
  try {
    const parsed = JSON.parse(data) as Partial<ProjectDecision>;
    return typeof parsed.projectId === "string" &&
      HOWS.includes(parsed.how ?? "") &&
      CONFIDENCES.includes(parsed.confidence ?? "")
      ? (parsed as ProjectDecision)
      : null;
  } catch {
    return null;
  }
}

// The session's project and task, from the store. An unbound session has project "": never a
// folder name. A session recorded before the identity event existed got its project from path
// resolution, so that is how it was decided.
export function sessionIdentity(
  session: Pick<Session, "projectId" | "taskId">,
  events: Pick<SessionEvent, "type" | "data">[] = [],
): SessionIdentity {
  const taskId = session.taskId ?? "";
  const projectId = session.projectId ?? "";
  if (!projectId) return { ...NO_PROJECT, taskId };
  const recorded = events
    .filter((event) => event.type === PROJECT_IDENTITY_EVENT)
    .map((event) => decisionFrom(event.data))
    .filter((decision) => decision?.projectId === projectId)
    .at(-1);
  return {
    projectId,
    how: recorded?.how ?? "path",
    confidence: recorded?.confidence ?? "high",
    taskId,
  };
}
