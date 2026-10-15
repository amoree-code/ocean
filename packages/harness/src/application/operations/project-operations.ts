import { mkdir } from "node:fs/promises";
import path from "node:path";
import { oceanPath, PROJECTS_DIR, projectFolder } from "../../paths.js";
import type { IntentClassification } from "../context/intent-router.js";
import {
  bindProject,
  projectConfirmationQuestion,
  resolveProject,
} from "../context/project-resolution.js";
import {
  approvalMatchesTarget,
  type OperationRecord,
  type OperationResult,
  operationResult,
  validateSlug,
  validateWriteTarget,
  type WriteApproval,
} from "./operation-contract.js";
import { crossProjectGuard, type OperationOptions } from "./operation-scope.js";
import { relativeToOcean } from "./record-io.js";

export async function projectDetect(
  classification: IntentClassification,
  cwd: string,
): Promise<OperationResult> {
  const resolution = await resolveProject(cwd);
  const record: OperationRecord = {
    identifier:
      resolution.status === "bound" ? resolution.projectId : "unbound",
    recordType: "project",
    provenance: "project",
    sourcePath:
      resolution.status === "bound"
        ? relativeToOcean(
            oceanPath(PROJECTS_DIR, projectFolder(resolution.projectId)),
          )
        : "",
    freshness: "unknown",
    confidence: classification.confidence,
    selectionReason: `project resolution status '${resolution.status}' for the given working directory`,
    fields: { status: resolution.status, confidence: resolution.confidence },
  };
  return {
    operation: "project.detect",
    ok: true,
    reason: `project resolution: ${resolution.status}`,
    records: [record],
    violations: [],
    written: null,
    packet: null,
    confirmationQuestion: projectConfirmationQuestion(resolution),
  };
}

export async function projectCreate(
  classification: IntentClassification,
  options: OperationOptions,
): Promise<OperationResult> {
  const name = validateSlug(classification.identifier, "project name");
  if (!name.valid)
    return operationResult("project.create", `write refused: ${name.reason}`);
  const projectPath = options.projectPath;
  if (typeof projectPath !== "string" || !path.isAbsolute(projectPath)) {
    return operationResult(
      "project.create",
      "write refused: an explicit absolute project path is required",
    );
  }
  if (projectPath.includes("\0"))
    return operationResult(
      "project.create",
      "write refused: project path contains a null byte",
    );

  const target = validateWriteTarget(PROJECTS_DIR, name.value);
  if (!target.valid)
    return operationResult("project.create", `write refused: ${target.reason}`);
  const approvalCheck = approvalMatchesTarget(
    options.approval as WriteApproval,
    target.value,
  );
  if (!approvalCheck.ok)
    return operationResult("project.create", approvalCheck.reason);

  const binding = await bindProject(name.value, projectPath);
  if (binding.conflict) {
    return operationResult(
      "project.create",
      `write refused: '${name.value}' conflicts with an existing binding at ${binding.conflict.path}`,
    );
  }
  await mkdir(target.value, { recursive: true });
  return {
    operation: "project.create",
    ok: true,
    reason: binding.created
      ? `project '${name.value}' created and bound to ${projectPath}`
      : `project '${name.value}' already bound to ${projectPath}`,
    records: [],
    violations: [],
    written: { sourcePath: relativeToOcean(target.value), bytes: 0 },
    packet: null,
  };
}

export async function projectUpdate(
  _classification: IntentClassification,
  options: OperationOptions,
  cwd: string,
): Promise<OperationResult> {
  const project = await crossProjectGuard(options, cwd);
  if (!project.ok) return operationResult("project.update", project.reason);
  const projectPath = options.projectPath;
  if (typeof projectPath !== "string" || !path.isAbsolute(projectPath)) {
    return operationResult(
      "project.update",
      "write refused: an explicit absolute project path is required",
    );
  }
  const target = validateWriteTarget(
    PROJECTS_DIR,
    projectFolder(project.projectId),
  );
  if (!target.valid)
    return operationResult("project.update", `write refused: ${target.reason}`);
  const approvalCheck = approvalMatchesTarget(
    options.approval as WriteApproval,
    target.value,
  );
  if (!approvalCheck.ok)
    return operationResult("project.update", approvalCheck.reason);
  const binding = await bindProject(project.projectId, projectPath);
  if (binding.conflict)
    return operationResult(
      "project.update",
      `write refused: binding conflict for '${project.projectId}'`,
    );
  return {
    operation: "project.update",
    ok: true,
    reason: `project '${project.projectId}' binding confirmed`,
    records: [],
    violations: [],
    written: { sourcePath: relativeToOcean(target.value), bytes: 0 },
    packet: null,
  };
}
