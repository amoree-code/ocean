import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { TASK_ID } from "../../domain/tasks/task-id.js";
import { atomicWrite } from "../../fs-utils.js";
import { PROJECTS_DIR, projectFolder } from "../../paths.js";
import type { ContextBudget } from "../context/context-ladder.js";
import type { IntentClassification } from "../context/intent-router.js";
import { withNextTaskId } from "../context/project-resolution.js";
import { completeTask } from "../tasks/archive-tasks.js";
import {
  resolveTaskReference,
  type TaskLocation,
} from "../tasks/task-reference.js";
import {
  approvalMatchesTarget,
  type OperationRecord,
  type OperationResult,
  operationResult,
  selectFields,
  shapeRecords,
  validateTaskIdentifier,
  validateWriteTarget,
  type WriteApproval,
} from "./operation-contract.js";
import {
  crossProjectGuard,
  type OperationOptions,
  taskRoot,
} from "./operation-scope.js";
import {
  FRONTMATTER_READ_BYTES,
  freshnessFor,
  readFrontmatterFile,
  relativeToOcean,
  requireAbsentTarget,
} from "./record-io.js";

const TASK_FIELDS = ["id", "title", "state", "goal", "priority", "updated_at"];
const MUTABLE_TASK_FIELDS = [
  "state",
  "goal",
  "priority",
  "updated_at",
  "next_action",
];

export async function taskGet(
  classification: IntentClassification,
  budget: ContextBudget,
  options: OperationOptions,
  cwd: string,
): Promise<OperationResult> {
  const identifier = validateTaskIdentifier(classification.identifier);
  if (!identifier.valid) return operationResult("task.get", identifier.reason);
  const project = await crossProjectGuard(options, cwd);
  if (!project.ok) return operationResult("task.get", project.reason);

  const resolved = await activeTask(identifier.value, project.projectId);
  if (!resolved.ok) return operationResult("task.get", resolved.reason);
  const file = resolved.location.file;

  const record = await readFrontmatterFile(file);
  if (!record)
    return operationResult(
      "task.get",
      `task ${identifier.value} was not found in project '${project.projectId}'`,
    );
  if (record.size > budget.maxBytes) {
    return operationResult(
      "task.get",
      `task ${identifier.value} is ${record.size} bytes, budget.maxBytes allows ${budget.maxBytes} — refusing to silently truncate`,
      { violations: ["max-bytes-exceeded"] },
    );
  }
  const shaped: OperationRecord = {
    identifier: identifier.value,
    recordType: "task",
    provenance: "task",
    sourcePath: relativeToOcean(file),
    freshness: freshnessFor(record.mtimeMs),
    confidence: classification.confidence,
    selectionReason: `exact task record requested by identifier ${identifier.value}`,
    fields: selectFields(record.fields, TASK_FIELDS),
  };
  return {
    operation: "task.get",
    ok: true,
    reason: `task ${identifier.value} selected`,
    records: [shaped],
    violations: [],
    written: null,
    packet: null,
  };
}

export async function taskList(
  classification: IntentClassification,
  budget: ContextBudget,
  options: OperationOptions,
  cwd: string,
): Promise<OperationResult> {
  const project = await crossProjectGuard(options, cwd);
  if (!project.ok) return operationResult("task.list", project.reason);

  const root = taskRoot(project.projectId);
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return operationResult(
      "task.list",
      `no task directory for project '${project.projectId}'`,
    );
  }

  const records: OperationRecord[] = [];
  const violations: string[] = [];
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "archive") continue;
    if (!TASK_ID.test(entry.name)) continue;
    const file = path.join(root, entry.name, "task.md");
    const record = await readFrontmatterFile(file);
    if (!record) continue;
    bytes += Math.min(record.size, FRONTMATTER_READ_BYTES);
    if (bytes > budget.maxBytes) {
      violations.push(
        `max-bytes-exceeded: stopped listing at ${bytes} bytes (budget ${budget.maxBytes})`,
      );
      break;
    }
    records.push({
      identifier: record.fields.id ?? entry.name,
      recordType: "task",
      provenance: "task",
      sourcePath: relativeToOcean(file),
      freshness: freshnessFor(record.mtimeMs),
      confidence: classification.confidence,
      selectionReason: `live task in project '${project.projectId}'`,
      fields: selectFields(record.fields, TASK_FIELDS),
    });
  }
  const shaped = shapeRecords(records, budget.maxFiles);
  return {
    operation: "task.list",
    ok: true,
    reason: `${shaped.records.length} task(s) listed for project '${project.projectId}'`,
    records: shaped.records,
    violations: [...violations, ...shaped.violations],
    written: null,
    packet: null,
  };
}

// Resolves the task inside the active project only. A prefix that belongs to another project
// gets the same refusal as any cross-project request.
async function activeTask(
  id: string,
  projectId: string,
): Promise<
  { ok: true; location: TaskLocation } | { ok: false; reason: string }
> {
  try {
    return {
      ok: true,
      location: await resolveTaskReference(id, {
        projectId,
        acrossProjects: false,
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const foreign = /^\S+ belongs to (\S+),/.exec(message);
    if (foreign)
      return {
        ok: false,
        reason: `cross-project request refused: active project is '${projectId}', request targeted '${foreign[1]}'`,
      };
    return {
      ok: false,
      reason: /is not a task in|no project uses prefix/.test(message)
        ? `task ${id} was not found in project '${projectId}'`
        : message,
    };
  }
}

export async function taskCreate(
  classification: IntentClassification,
  options: OperationOptions,
  cwd: string,
): Promise<OperationResult> {
  const project = await crossProjectGuard(options, cwd);
  if (!project.ok) return operationResult("task.create", project.reason);
  const title = classification.identifier?.trim();
  if (!title || title.length > 200 || /[\r\n]/.test(title))
    return operationResult(
      "task.create",
      "write refused: an explicit single-line task title is required",
    );
  // Resolve the folder once so the id and the write target can never disagree.
  const folder = projectFolder(project.projectId);
  const today = new Date().toISOString().slice(0, 10);
  const objective = (options.content ?? title).trim().replace(/[\r\n]+/g, " ");
  // The approval is bound to the path of the id that was predicted when it was granted. The id
  // is issued under the projects lock, so a creator that lost the race is refused (and consumes
  // nothing) instead of writing under an id nobody approved.
  return withNextTaskId(project.projectId, async (id) => {
    const target = validateWriteTarget(
      PROJECTS_DIR,
      folder,
      "tasks",
      id,
      "task.md",
    );
    if (!target.valid) return operationResult("task.create", target.reason);
    const approvalCheck = approvalMatchesTarget(
      options.approval as WriteApproval,
      target.value,
    );
    if (!approvalCheck.ok)
      return operationResult(
        "task.create",
        `write refused: the next id is now ${id}; the approval covered ${options.approval?.target} — request a new approval`,
      );
    const absent = await requireAbsentTarget(target.value);
    if (!absent.ok) return operationResult("task.create", absent.reason);
    const source = `---\nid: ${id}\ntitle: ${title}\nstate: active\nproject: ${project.projectId}\nopened: ${today}\nupdated: ${today}\nartifacts: []\nclass: medium\nexpected_context: medium\n---\n\n## Objective\n\n${objective}\n\n## Definition of done\n\nThe requested outcome is implemented and its verification passes.\n\n## Next action\n\nInspect the project and define the first implementation slice.\n\n## Verification\n\nPending.\n\n## Blockers\n\nNone.\n\n## Log\n\n- ${today} — Task created.\n`;
    try {
      await mkdir(path.dirname(target.value), { recursive: true });
      const bytes = await atomicWrite(target.value, source);
      return {
        operation: "task.create",
        ok: true,
        reason: `${id} created for project '${project.projectId}'`,
        records: [],
        violations: [],
        written: { sourcePath: relativeToOcean(target.value), bytes },
        packet: null,
      } satisfies OperationResult;
    } catch (error) {
      return operationResult(
        "task.create",
        `task creation failed atomically, no partial content left: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

export async function taskUpdate(
  classification: IntentClassification,
  budget: ContextBudget,
  options: OperationOptions,
  cwd: string,
): Promise<OperationResult> {
  const identifier = validateTaskIdentifier(classification.identifier);
  if (!identifier.valid)
    return operationResult("task.update", identifier.reason);
  const project = await crossProjectGuard(options, cwd);
  if (!project.ok) return operationResult("task.update", project.reason);
  const patch = options.patch ?? {};
  const patchKeys = Object.keys(patch);
  if (patchKeys.length === 0)
    return operationResult(
      "task.update",
      "write refused: no explicit field patch supplied",
    );
  const unknownField = patchKeys.find(
    (key) => !MUTABLE_TASK_FIELDS.includes(key),
  );
  if (unknownField)
    return operationResult(
      "task.update",
      `write refused: field '${unknownField}' is not an updatable task field`,
    );

  const resolved = await activeTask(identifier.value, project.projectId);
  if (!resolved.ok || resolved.location.archived)
    return operationResult(
      "task.update",
      resolved.ok
        ? `task ${identifier.value} was not found in project '${project.projectId}'`
        : resolved.reason,
    );
  const target = validateWriteTarget(
    PROJECTS_DIR,
    projectFolder(project.projectId),
    "tasks",
    resolved.location.id,
    "task.md",
  );
  if (!target.valid) return operationResult("task.update", target.reason);
  const approvalCheck = approvalMatchesTarget(
    options.approval as WriteApproval,
    target.value,
  );
  if (!approvalCheck.ok)
    return operationResult("task.update", approvalCheck.reason);

  let source: string;
  try {
    source = await readFile(target.value, "utf8");
  } catch {
    return operationResult(
      "task.update",
      `task ${identifier.value} was not found in project '${project.projectId}'`,
    );
  }
  if (Buffer.byteLength(source, "utf8") > budget.maxBytes) {
    return operationResult(
      "task.update",
      `task ${identifier.value} exceeds budget.maxBytes (${budget.maxBytes}) — refusing to rewrite a record it cannot fully read`,
      { violations: ["max-bytes-exceeded"] },
    );
  }

  let updated = source;
  for (const [key, value] of Object.entries(patch)) {
    if (value.includes("\n"))
      return operationResult(
        "task.update",
        `write refused: value for '${key}' must be a single line`,
      );
    const pattern = new RegExp(`^${key}:.*$`, "m");
    updated = pattern.test(updated)
      ? updated.replace(pattern, `${key}: ${value}`)
      : updated;
  }
  if (updated === source)
    return operationResult(
      "task.update",
      "write refused: patch did not match any existing frontmatter field",
    );

  const bytes = await atomicWrite(target.value, updated);
  return {
    operation: "task.update",
    ok: true,
    reason: `task ${identifier.value} updated (${patchKeys.join(", ")})`,
    records: [],
    violations: [],
    written: { sourcePath: relativeToOcean(target.value), bytes },
    packet: null,
  };
}

export async function taskCompleteOperation(
  classification: IntentClassification,
  _budget: ContextBudget,
  options: OperationOptions,
  cwd: string,
): Promise<OperationResult> {
  const identifier = validateTaskIdentifier(classification.identifier);
  if (!identifier.valid)
    return operationResult("task.complete", identifier.reason);
  const project = await crossProjectGuard(options, cwd);
  if (!project.ok) return operationResult("task.complete", project.reason);

  const resolved = await activeTask(identifier.value, project.projectId);
  if (!resolved.ok || resolved.location.archived)
    return operationResult(
      "task.complete",
      resolved.ok
        ? `task ${identifier.value} was not found in project '${project.projectId}'`
        : resolved.reason,
    );
  const target = validateWriteTarget(
    PROJECTS_DIR,
    projectFolder(project.projectId),
    "tasks",
    resolved.location.id,
    "task.md",
  );
  if (!target.valid) return operationResult("task.complete", target.reason);
  const approvalCheck = approvalMatchesTarget(
    options.approval as WriteApproval,
    target.value,
  );
  if (!approvalCheck.ok)
    return operationResult("task.complete", approvalCheck.reason);

  try {
    // Reuses the existing governed completion path: it refuses a task with unchecked work.
    const result = await completeTask(
      resolved.location.id,
      taskRoot(project.projectId),
    );
    return {
      operation: "task.complete",
      ok: true,
      reason: `task ${identifier.value} completed (state: ${result.state})`,
      records: [],
      violations: [],
      written: { sourcePath: relativeToOcean(target.value), bytes: 0 },
      packet: null,
    };
  } catch (error) {
    return operationResult(
      "task.complete",
      error instanceof Error ? error.message : String(error),
    );
  }
}
