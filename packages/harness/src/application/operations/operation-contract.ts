import path from "node:path";
import { TASK_ID } from "@ocean/core/domain/tasks/task-id.js";
import {
  engineRoot,
  oceanRoot,
  resolveWithin,
} from "@ocean/core/shared/paths.js";
import { validateBudget } from "../context/context-ladder.js";
import type {
  ContextPacket,
  Freshness,
  RecordType,
} from "../context/context-packet.js";
import type { IntentClassification } from "../context/intent-router.js";

// Shared contract for T-198 slice 7 operations. Every operation — read or write — passes
// through the same validation gate: explicit intent, explicit identifier or create target,
// path safety, budget validity, and (for writes) an explicit approval. Nothing here guesses
// an identifier, a project, or a destination.

export type OperationName =
  | "task.get"
  | "task.list"
  | "task.update"
  | "task.complete"
  | "task.create"
  | "memory.search"
  | "memory.write"
  | "knowledge.search"
  | "knowledge.write"
  | "project.detect"
  | "project.create"
  | "project.update";

export type OperationKind = "read" | "write";

export const OPERATION_KIND: Record<OperationName, OperationKind> = {
  "task.get": "read",
  "task.list": "read",
  "task.update": "write",
  "task.complete": "write",
  "task.create": "write",
  "memory.search": "read",
  "memory.write": "write",
  "knowledge.search": "read",
  "knowledge.write": "write",
  "project.detect": "read",
  "project.create": "write",
  "project.update": "write",
};

export type OperationRecord = {
  identifier: string;
  recordType: RecordType;
  provenance:
    | "fact"
    | "preference"
    | "decision"
    | "lesson"
    | "proposal"
    | "temporary-note"
    | "task"
    | "project"
    | "execution"
    | "unknown";
  sourcePath: string;
  freshness: Freshness;
  confidence: IntentClassification["confidence"];
  selectionReason: string;
  fields: Record<string, string>;
};

export type OperationResult = {
  operation: OperationName;
  ok: boolean;
  reason: string;
  records: OperationRecord[];
  violations: string[];
  written: { sourcePath: string; bytes: number } | null;
  packet: ContextPacket | null;
  confirmationQuestion?: string | null;
};

export type WriteApproval = {
  approved: boolean;
  // The exact operation and target the approval was granted for. An approval for one target
  // is never accepted for another — checked, not trusted.
  operation: OperationName;
  target: string;
};

export function operationResult(
  operation: OperationName,
  reason: string,
  overrides: Partial<OperationResult> = {},
): OperationResult {
  return {
    operation,
    ok: false,
    reason,
    records: [],
    violations: [],
    written: null,
    packet: null,
    ...overrides,
  };
}

// --- identifier and path validation -------------------------------------------------

// Record slugs and project names: conservative allow-list, no dots that could build "..",
// no separators, no shell syntax, no whitespace.
const SLUG_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/i;

export function validateTaskIdentifier(
  identifier: unknown,
): { valid: true; value: string } | { valid: false; reason: string } {
  if (typeof identifier !== "string" || identifier.length === 0)
    return { valid: false, reason: "task identifier is missing" };
  if (identifier.includes("\0"))
    return { valid: false, reason: "task identifier contains a null byte" };
  if (!TASK_ID.test(identifier))
    return {
      valid: false,
      reason: `task identifier '${identifier}' does not match the required <PREFIX>-<digits> shape, expected <PREFIX>-<digits>`,
    };
  return { valid: true, value: identifier };
}

export function validateSlug(
  slug: unknown,
  label: string,
): { valid: true; value: string } | { valid: false; reason: string } {
  if (typeof slug !== "string" || slug.length === 0)
    return { valid: false, reason: `${label} is missing` };
  if (slug.includes("\0"))
    return { valid: false, reason: `${label} contains a null byte` };
  if (path.isAbsolute(slug))
    return { valid: false, reason: `${label} must not be an absolute path` };
  if (slug.includes(".."))
    return {
      valid: false,
      reason: `${label} must not contain a traversal segment`,
    };
  if (/[;&|`$()<>\\/\s]/.test(slug))
    return {
      valid: false,
      reason: `${label} contains an unsafe or separator character`,
    };
  if (!SLUG_SHAPE.test(slug))
    return {
      valid: false,
      reason: `${label} '${slug}' does not match the allowed shape`,
    };
  return { valid: true, value: slug };
}

// A write destination must resolve inside the private Ocean workspace root and must never
// land inside the public engine package, whatever the caller passed.
export function validateWriteTarget(
  ...segments: string[]
): { valid: true; value: string } | { valid: false; reason: string } {
  let resolved: string;
  try {
    resolved = resolveWithin(oceanRoot(), ...segments);
  } catch {
    return { valid: false, reason: "write target escapes the Ocean root" };
  }
  const engine = path.resolve(engineRoot());
  if (resolved === engine || resolved.startsWith(`${engine}${path.sep}`)) {
    return {
      valid: false,
      reason:
        "refusing to write private Ocean content inside the public engine package",
    };
  }
  return { valid: true, value: resolved };
}

// --- operation/intent validation ----------------------------------------------------

// The single source of truth for which classified intent may drive which operation. An
// operation requested for an intent that does not map to it is refused, not coerced.
export function operationForIntent(
  classification: IntentClassification,
): { operation: OperationName } | { operation: null; reason: string } {
  const { intent, action, identifier } = classification;
  if (intent === "task-lookup") {
    if (action === "complete") return { operation: "task.complete" };
    if (action === "update") return { operation: "task.update" };
    if (identifier) return { operation: "task.get" };
    return { operation: "task.list" };
  }
  if (intent === "task-create") return { operation: "task.create" };
  if (intent === "memory-lookup") return { operation: "memory.search" };
  if (intent === "work-style-lookup") return { operation: "memory.search" };
  if (intent === "knowledge-lookup") return { operation: "knowledge.search" };
  if (intent === "decision-lookup") return { operation: "knowledge.search" };
  if (intent === "project-detect") return { operation: "project.detect" };
  if (intent === "project-create") return { operation: "project.create" };
  if (intent === "remember") {
    if (
      classification.entityType === "knowledge" ||
      classification.entityType === "decision"
    )
      return { operation: "knowledge.write" };
    return { operation: "memory.write" };
  }
  return {
    operation: null,
    reason: `intent '${intent}' does not map to any Ocean record operation`,
  };
}

function assertOperationMatchesIntent(
  operation: OperationName,
  classification: IntentClassification,
): { ok: true } | { ok: false; reason: string } {
  const mapped = operationForIntent(classification);
  if (!mapped.operation) return { ok: false, reason: mapped.reason };
  if (mapped.operation !== operation) {
    return {
      ok: false,
      reason: `operation '${operation}' does not match intent '${classification.intent}' (which maps to '${mapped.operation}')`,
    };
  }
  return { ok: true };
}

// --- gate shared by every operation --------------------------------------------------

export type OperationGate = { ok: true } | { ok: false; reason: string };

// Writes are fail-closed: only a high-confidence, unambiguous classification, with a valid
// budget and an approval naming this exact operation and target, may proceed.
export function gateOperation(
  operation: OperationName,
  classification: IntentClassification,
  budget: unknown,
  approval?: WriteApproval,
): OperationGate {
  const intentCheck = assertOperationMatchesIntent(operation, classification);
  if (!intentCheck.ok) return intentCheck;

  const budgetCheck = validateBudget(budget);
  if (!budgetCheck.valid)
    return { ok: false, reason: `invalid-budget: ${budgetCheck.reason}` };

  if (classification.intent === "unknown")
    return { ok: false, reason: "unknown intent — failing closed" };
  if (classification.ambiguityReason)
    return {
      ok: false,
      reason: `ambiguous intent — failing closed: ${classification.ambiguityReason}`,
    };

  if (OPERATION_KIND[operation] === "read") return { ok: true };

  if (classification.confidence !== "high") {
    return {
      ok: false,
      reason: `write refused: intent confidence is '${classification.confidence}', only 'high' may write`,
    };
  }
  if (approval?.approved !== true)
    return {
      ok: false,
      reason: "write refused: no explicit approval was supplied",
    };
  if (approval.operation !== operation)
    return {
      ok: false,
      reason: `write refused: approval was granted for '${approval.operation}', not '${operation}'`,
    };
  return { ok: true };
}

export function approvalMatchesTarget(
  approval: WriteApproval,
  resolvedTarget: string,
): OperationGate {
  const approvedTarget = path.resolve(approval.target);
  if (approvedTarget !== path.resolve(resolvedTarget)) {
    return {
      ok: false,
      reason: `write refused: approval target '${approval.target}' does not match the resolved destination`,
    };
  }
  return { ok: true };
}

// --- bounded result shaping -----------------------------------------------------------

// Stable order (by identifier), deterministic deduplication (by identifier + sourcePath),
// and a hard result cap taken from the caller's budget.
export function shapeRecords(
  records: OperationRecord[],
  maxRecords: number,
): { records: OperationRecord[]; violations: string[] } {
  const violations: string[] = [];
  const seen = new Set<string>();
  const unique: OperationRecord[] = [];
  for (const record of records) {
    const key = `${record.identifier}::${record.sourcePath}`;
    if (seen.has(key)) {
      violations.push(`duplicate record skipped: ${key}`);
      continue;
    }
    seen.add(key);
    unique.push(record);
  }
  unique.sort(
    (left, right) =>
      left.identifier.localeCompare(right.identifier) ||
      left.sourcePath.localeCompare(right.sourcePath),
  );
  if (unique.length > maxRecords) {
    violations.push(
      `result truncated to maxFiles=${maxRecords} (${unique.length} candidates matched)`,
    );
    return { records: unique.slice(0, maxRecords), violations };
  }
  return { records: unique, violations };
}

// Field selection: only the named fields survive into a record, and each value is clipped
// so one oversized frontmatter value cannot make a result unbounded.
const MAX_FIELD_CHARS = 200;

export function selectFields(
  source: Record<string, string>,
  fields: string[],
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const field of fields) {
    const value = source[field];
    if (value === undefined) continue;
    selected[field] =
      value.length > MAX_FIELD_CHARS
        ? `${value.slice(0, MAX_FIELD_CHARS)}…`
        : value;
  }
  return selected;
}
