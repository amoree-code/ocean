import type { BrainIndexPort } from "@ocean/core/domain/ports/brain-index-port.js";
import {
  oceanPath,
  PROJECTS_DIR,
  projectFolder,
  sameProject,
} from "../../paths.js";
import { resolveProject } from "../../shared/project-resolution.js";
import type { OperationRecord, WriteApproval } from "./operation-contract.js";

export type OperationOptions = {
  cwd?: string;
  approval?: WriteApproval;
  requestedProject?: string;
  patch?: Record<string, string>;
  content?: string;
  slug?: string;
  kind?: string;
  query?: string;
  projectPath?: string;
  provenance?: OperationRecord["provenance"];
  correctionOf?: string;
  // When supplied, memory.search/knowledge.search rank results through the brain index
  // (T-228) instead of a plain substring match. Optional and additive: every existing
  // caller that omits it keeps today's substring-search behavior unchanged.
  indexPort?: BrainIndexPort;
};

export type ProjectScope =
  | { ok: true; projectId: string }
  | { ok: false; reason: string };

async function activeProjectId(cwd: string): Promise<ProjectScope> {
  const resolution = await resolveProject(cwd);
  if (resolution.status === "bound")
    return { ok: true, projectId: resolution.projectId };
  return {
    ok: false,
    reason: `no bound Ocean project for this working directory (status: ${resolution.status})`,
  };
}

export function taskRoot(projectId: string): string {
  return oceanPath(PROJECTS_DIR, projectFolder(projectId), "tasks");
}

export async function crossProjectGuard(
  options: OperationOptions,
  cwd: string,
): Promise<ProjectScope> {
  const active = await activeProjectId(cwd);
  if (!active.ok) return active;
  if (
    options.requestedProject &&
    !sameProject(options.requestedProject, active.projectId)
  ) {
    return {
      ok: false,
      reason: `cross-project request refused: active project is '${active.projectId}', request targeted '${options.requestedProject}'`,
    };
  }
  return active;
}
