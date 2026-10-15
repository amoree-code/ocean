import { KNOWLEDGE_DIR, PERSONAL_DIR } from "../../paths.js";
import type { ContextBudget } from "../context/context-ladder.js";
import type { IntentClassification } from "../context/intent-router.js";
import { searchRecords, writeRecord } from "./memory-knowledge-operations.js";
import {
  gateOperation,
  type OperationName,
  type OperationResult,
  operationResult,
} from "./operation-contract.js";
import type { OperationOptions } from "./operation-scope.js";
import {
  projectCreate,
  projectDetect,
  projectUpdate,
} from "./project-operations.js";
import {
  taskCompleteOperation,
  taskCreate,
  taskGet,
  taskList,
  taskUpdate,
} from "./task-operations.js";

export type { OperationOptions } from "./operation-scope.js";

// Table-driven dispatch over the focused operation modules (task/memory/knowledge/project).
// This module is the sole public entry point — see operation-scope.ts, record-io.ts,
// task-operations.ts, memory-knowledge-operations.ts, and project-operations.ts for the
// implementations.
export async function runOperation(
  operation: OperationName,
  classification: IntentClassification,
  budget: unknown,
  options: OperationOptions = {},
): Promise<OperationResult> {
  const gate = gateOperation(
    operation,
    classification,
    budget,
    options.approval,
  );
  if (!gate.ok) return operationResult(operation, gate.reason);
  const bounded = budget as ContextBudget;
  const cwd = options.cwd ?? process.cwd();

  switch (operation) {
    case "task.get":
      return taskGet(classification, bounded, options, cwd);
    case "task.list":
      return taskList(classification, bounded, options, cwd);
    case "task.update":
      return taskUpdate(classification, bounded, options, cwd);
    case "task.complete":
      return taskCompleteOperation(classification, bounded, options, cwd);
    case "task.create":
      return taskCreate(classification, options, cwd);
    case "memory.search":
      return searchRecords(
        "memory.search",
        "memory",
        [PERSONAL_DIR],
        classification,
        bounded,
        options,
      );
    case "knowledge.search":
      return searchRecords(
        "knowledge.search",
        "knowledge",
        [KNOWLEDGE_DIR],
        classification,
        bounded,
        options,
      );
    case "memory.write":
      return writeRecord("memory.write", options, bounded);
    case "knowledge.write":
      return writeRecord("knowledge.write", options, bounded);
    case "project.detect":
      return projectDetect(classification, cwd);
    case "project.create":
      return projectCreate(classification, options);
    case "project.update":
      return projectUpdate(classification, options, cwd);
    default:
      return operationResult(operation, `unsupported operation '${operation}'`);
  }
}
