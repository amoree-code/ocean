import path from "node:path";
import { validateBudget } from "@ocean/context/context/context-ladder.js";
import type { SessionStorePort } from "@ocean/core/domain/ports/session-store-port.js";
import type {
  Session,
  SessionStatus,
} from "@ocean/core/domain/sessions/session.js";
import { sameProject } from "@ocean/core/shared/paths.js";
import { resolveProject } from "@ocean/core/shared/project-resolution.js";

// Session pointer and resume planning (T-198 slice 8). A pointer is a compact reference to
// an existing session — ids, project, status, and a checkpoint *reference* — never the
// transcript and never event content. Nothing here invokes a provider, mutates a session
// row, or stores anything outside the existing session SQLite boundary: resuming means
// starting a new child session that points at the parent, never reopening a closed one.

export type SessionPointer = {
  sessionId: string;
  parentSessionId: string | null;
  projectId: string | null;
  provider: string;
  status: SessionStatus;
  taskId: string | null;
  checkpointRef: string | null;
  nextAction: string;
  updatedAt: string;
};

type ResumeMode = "attach-child" | "pointer-only" | "refused";

export type ResumePlan = {
  ok: boolean;
  mode: ResumeMode;
  reason: string;
  pointer: SessionPointer | null;
  parentSessionId: string | null;
  violations: string[];
};

// Sessions are created with randomUUID(), so a pointer that is not a UUID did not come from
// Ocean and is refused before any lookup.
const SESSION_ID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STALE_RESUME_MS = 24 * 60 * 60 * 1000;
const MAX_NEXT_ACTION_CHARS = 200;

export function validateSessionIdentifier(
  sessionId: unknown,
): { valid: true; value: string } | { valid: false; reason: string } {
  if (typeof sessionId !== "string" || sessionId.length === 0)
    return { valid: false, reason: "session pointer is missing" };
  if (sessionId.includes("\0"))
    return { valid: false, reason: "session pointer contains a null byte" };
  if (!SESSION_ID_SHAPE.test(sessionId))
    return {
      valid: false,
      reason: `session pointer '${sessionId}' is not a valid Ocean session identifier`,
    };
  return { valid: true, value: sessionId };
}

function refused(reason: string, violations: string[] = []): ResumePlan {
  return {
    ok: false,
    mode: "refused",
    reason,
    pointer: null,
    parentSessionId: null,
    violations,
  };
}

function clip(value: string): string {
  return value.length > MAX_NEXT_ACTION_CHARS
    ? `${value.slice(0, MAX_NEXT_ACTION_CHARS)}…`
    : value;
}

async function projectIdFor(directory: string): Promise<string | null> {
  const resolution = await resolveProject(directory);
  return resolution.status === "bound" ? resolution.projectId : null;
}

// Builds the compact pointer for a session that is already known to exist. Carries only
// references: summaryPath is a path, not the summary; nextAction is clipped.
export async function buildSessionPointer(
  session: Session,
): Promise<SessionPointer> {
  return {
    sessionId: session.sessionId,
    parentSessionId: session.parentSessionId,
    projectId: await projectIdFor(session.workingDirectory),
    provider: session.provider,
    status: session.status,
    taskId: session.taskId,
    checkpointRef: session.summaryPath,
    nextAction: clip(session.nextAction ?? ""),
    updatedAt: session.updatedAt,
  };
}

export type ResumeOptions = {
  cwd?: string;
  now?: number;
  requestedProject?: string;
};

// Deterministic, read-only resume planning. Budget is validated before the store is read.
export async function planSessionResume(
  store: SessionStorePort,
  sessionId: unknown,
  budget: unknown,
  options: ResumeOptions = {},
): Promise<ResumePlan> {
  const budgetCheck = validateBudget(budget);
  if (!budgetCheck.valid)
    return refused(`invalid-budget: ${budgetCheck.reason}`, ["invalid-budget"]);

  const identifier = validateSessionIdentifier(sessionId);
  if (!identifier.valid) return refused(identifier.reason);

  const session = store.get(identifier.value);
  if (!session)
    return refused(`session ${identifier.value} does not exist in Ocean`);

  const pointer = await buildSessionPointer(session);

  const cwd = options.cwd;
  if (cwd) {
    const currentProject = await projectIdFor(path.resolve(cwd));
    if (
      pointer.projectId &&
      currentProject &&
      !sameProject(pointer.projectId, currentProject)
    ) {
      return refused(
        `cross-project resume refused: session belongs to '${pointer.projectId}', current directory resolves to '${currentProject}'`,
      );
    }
  }
  if (
    options.requestedProject &&
    pointer.projectId &&
    !sameProject(options.requestedProject, pointer.projectId)
  ) {
    return refused(
      `cross-project resume refused: session belongs to '${pointer.projectId}', request targeted '${options.requestedProject}'`,
    );
  }

  const now = options.now ?? Date.now();
  const age = now - Date.parse(session.updatedAt);

  if (session.status === "created") {
    return refused(
      `session ${identifier.value} never started (status: created) — nothing to resume`,
    );
  }
  if (session.status === "failed" || session.status === "cancelled") {
    return refused(
      `session ${identifier.value} ended in terminal status '${session.status}' — a new session must be started explicitly, Ocean will not reassign it automatically`,
    );
  }
  if (
    session.status === "running" &&
    Number.isFinite(age) &&
    age > STALE_RESUME_MS
  ) {
    return refused(
      `session ${identifier.value} is stale: last updated ${Math.floor(age / 3_600_000)}h ago while still marked running — run 'ocean session doctor' before resuming`,
      ["stale-session"],
    );
  }

  const mode: ResumeMode =
    session.status === "running" ? "attach-child" : "pointer-only";
  const plan: ResumePlan = {
    ok: true,
    mode,
    reason:
      mode === "attach-child"
        ? `session ${identifier.value} is live; a child session may attach to it`
        : `session ${identifier.value} is closed cleanly; a new child session may point at its checkpoint without replaying it`,
    pointer,
    parentSessionId: identifier.value,
    violations: [],
  };

  const bounded = budget as { maxChars: number };
  const serialized = JSON.stringify(plan).length;
  if (serialized > bounded.maxChars) {
    return refused(
      `resume plan is ${serialized} chars, budget.maxChars allows ${bounded.maxChars}`,
      ["max-chars-exceeded"],
    );
  }
  return plan;
}

// Validates an explicitly supplied parent before a caller passes it to store.create().
// A missing parent is reported as "none", never inferred from the most recent session.
export function validateParentSession(
  store: SessionStorePort,
  parentSessionId: unknown,
  childSessionId?: string,
):
  | { ok: true; parentSessionId: string | null }
  | { ok: false; reason: string } {
  if (parentSessionId === null || parentSessionId === undefined) {
    return { ok: true, parentSessionId: null };
  }
  const identifier = validateSessionIdentifier(parentSessionId);
  if (!identifier.valid) return { ok: false, reason: identifier.reason };
  if (childSessionId && childSessionId === identifier.value) {
    return { ok: false, reason: "a session cannot be its own parent" };
  }
  const parent = store.get(identifier.value);
  if (!parent)
    return {
      ok: false,
      reason: `parent session ${identifier.value} does not exist in Ocean`,
    };
  return { ok: true, parentSessionId: identifier.value };
}
