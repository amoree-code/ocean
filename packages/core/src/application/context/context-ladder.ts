import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { BrainIndexPort } from "../../domain/ports/brain-index-port.js";
import { parseTaskId } from "../../domain/tasks/task-id.js";
import {
  KNOWLEDGE_DIR,
  oceanRoot,
  PERSONAL_DIR,
  resolveStorePath,
  resolveWithin,
  storeRelativeToRoot,
  WORKSPACE_PROJECT_ID,
} from "../../paths.js";
import { brainSearch } from "../brain/brain-service.js";
import { resolveTaskReference } from "../tasks/task-reference.js";
import type { IntentClassification } from "./intent-router.js";

// Context ladder: startup identity only -> project metadata -> ranked references -> exact
// record by id. Each rung is resolved deterministically from a slice-4 IntentClassification,
// and no rung above "identity" is ever reached for a low-confidence, ambiguous, or unknown
// classification (fail-closed). No rung here reads file content — it only validates a
// budget and, for "exact-record", stats a single bounded, path-checked candidate file to
// prove size before any later slice is allowed to read it. See T-198 slice 5.
export type LadderRung =
  | "identity"
  | "project-metadata"
  | "ranked-references"
  | "exact-record";

export type ContextBudget = {
  maxFiles: number;
  maxBytes: number;
  maxChars: number;
  maxOperationCost: number;
};

// Hard ceilings: a caller cannot request an arbitrarily large budget and call it "bounded".
// These are generous enough for a single compact read, never for a repository scan.
const BUDGET_CEILING: ContextBudget = {
  maxFiles: 20,
  maxBytes: 200_000,
  maxChars: 50_000,
  maxOperationCost: 10,
};

type BudgetViolation =
  | "invalid-budget"
  | "max-files-exceeded"
  | "max-bytes-exceeded"
  | "max-chars-exceeded"
  | "max-operation-cost-exceeded"
  | null;

export type BoundedReadResult = {
  rung: LadderRung;
  allowed: boolean;
  reason: string;
  violation: BudgetViolation;
  files: string[];
  bytes: number;
  truncated: boolean;
};

function isBoundedPositiveInteger(value: unknown, ceiling: number): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= ceiling
  );
}

// Rejects missing, non-numeric, negative, zero, NaN, Infinity, non-integer, and
// oversized-beyond-ceiling budgets. A budget that passes this check is never itself the
// reason a read becomes unbounded.
export function validateBudget(
  budget: unknown,
): { valid: true } | { valid: false; reason: string } {
  if (!budget || typeof budget !== "object")
    return { valid: false, reason: "budget is missing or not an object" };
  const candidate = budget as Partial<ContextBudget>;
  const fields: (keyof ContextBudget)[] = [
    "maxFiles",
    "maxBytes",
    "maxChars",
    "maxOperationCost",
  ];
  for (const field of fields) {
    const value = candidate[field];
    if (value === undefined)
      return { valid: false, reason: `budget.${field} is missing` };
    if (!isBoundedPositiveInteger(value, BUDGET_CEILING[field])) {
      return {
        valid: false,
        reason: `budget.${field} must be a finite positive integer no greater than ${BUDGET_CEILING[field]} (got ${String(value)})`,
      };
    }
  }
  return { valid: true };
}

const READ_RUNG_COST: Record<LadderRung, number> = {
  identity: 0,
  "project-metadata": 1,
  "ranked-references": 3,
  "exact-record": 1,
};

// Fail-closed: any low confidence, any ambiguity reason, or the "unknown" intent stays at
// "identity" — no project metadata, no reference ranking, no record fetch is attempted.
export function resolveLadderRung(classification: IntentClassification): {
  rung: LadderRung;
  reason: string;
} {
  if (
    classification.intent === "unknown" ||
    classification.confidence === "low" ||
    classification.ambiguityReason
  ) {
    return {
      rung: "identity",
      reason:
        "low confidence, ambiguous, or unknown intent — failing closed at identity, no read attempted",
    };
  }
  if (classification.intent === "project-detect") {
    return {
      rung: "project-metadata",
      reason: "project-detect intent resolves to project metadata only",
    };
  }
  if (classification.intent === "task-lookup" && classification.identifier) {
    return {
      rung: "exact-record",
      reason:
        "task-lookup with an explicit, validated identifier resolves to an exact record",
    };
  }
  if (
    classification.intent === "memory-lookup" ||
    classification.intent === "knowledge-lookup" ||
    classification.intent === "decision-lookup"
  ) {
    return {
      rung: "ranked-references",
      reason: `${classification.intent} has no explicit identifier — resolves to ranked references, not a full record`,
    };
  }
  return {
    rung: "identity",
    reason: `intent '${classification.intent}' is a write/execution/create request, not a read — the context ladder does not escalate past identity for it`,
  };
}

function budgetRejection(
  rung: LadderRung,
  reason: string,
  violation: BudgetViolation = "invalid-budget",
): BoundedReadResult {
  return {
    rung,
    allowed: false,
    reason,
    violation,
    files: [],
    bytes: 0,
    truncated: false,
  };
}

function withinCharBudget(
  result: Omit<BoundedReadResult, "violation" | "allowed" | "reason"> & {
    reason: string;
  },
  budget: ContextBudget,
  rung: LadderRung,
): BoundedReadResult {
  const serializedChars = JSON.stringify(result).length;
  if (serializedChars > budget.maxChars) {
    return budgetRejection(
      rung,
      `context result is ${serializedChars} chars, budget allows ${budget.maxChars}`,
      "max-chars-exceeded",
    );
  }
  return { ...result, allowed: true, violation: null };
}

// Only ever resolves a single, already-validated task id to its task.md path, and only
// ever stats it (size), never reads its content — the actual compact read is a later slice.
async function planExactTaskRecord(
  identifier: string,
  budget: ContextBudget,
  root = oceanRoot(),
  projectId = WORKSPACE_PROJECT_ID,
): Promise<BoundedReadResult> {
  const rung: LadderRung = "exact-record";
  const parsed = parseTaskId(identifier);
  if (!parsed) {
    return budgetRejection(
      rung,
      `'${identifier}' is not a valid task identifier shape (expected <PREFIX>-<digits>) — refusing to guess a path`,
      null,
    );
  }
  const cost = READ_RUNG_COST[rung];
  if (cost > budget.maxOperationCost) {
    return budgetRejection(
      rung,
      `exact-record operation cost ${cost} exceeds budget.maxOperationCost ${budget.maxOperationCost}`,
      "max-operation-cost-exceeded",
    );
  }
  if (1 > budget.maxFiles) {
    return budgetRejection(
      rung,
      `a single task record requires 1 file, budget.maxFiles is ${budget.maxFiles}`,
      "max-files-exceeded",
    );
  }
  const normalized = `${parsed.prefix}${identifier.slice(identifier.indexOf("-"))}`;
  // Stays inside this project: the ladder never reads another project's task.
  let resolvedPath: string;
  try {
    resolvedPath = (
      await resolveTaskReference(identifier, {
        projectId,
        acrossProjects: false,
        root,
      })
    ).file;
  } catch {
    return budgetRejection(
      rung,
      `task ${normalized} was not found under the Ocean task root`,
      null,
    );
  }
  let size: number;
  try {
    size = (await stat(resolvedPath)).size;
  } catch {
    return budgetRejection(
      rung,
      `task ${normalized} was not found under the Ocean task root`,
      null,
    );
  }
  if (size > budget.maxBytes) {
    return budgetRejection(
      rung,
      `task ${normalized} is ${size} bytes, budget.maxBytes allows ${budget.maxBytes} — refusing to silently truncate`,
      "max-bytes-exceeded",
    );
  }
  const relative = path.relative(root, resolvedPath).split(path.sep).join("/");
  return withinCharBudget(
    {
      rung,
      files: [relative],
      bytes: size,
      truncated: false,
      reason: `task ${normalized} is within budget (${size}/${budget.maxBytes} bytes)`,
    },
    budget,
    rung,
  );
}

function planProjectMetadata(budget: ContextBudget): BoundedReadResult {
  const rung: LadderRung = "project-metadata";
  const cost = READ_RUNG_COST[rung];
  if (cost > budget.maxOperationCost) {
    return budgetRejection(
      rung,
      `project-metadata operation cost ${cost} exceeds budget.maxOperationCost ${budget.maxOperationCost}`,
      "max-operation-cost-exceeded",
    );
  }
  return withinCharBudget(
    {
      rung,
      files: [],
      bytes: 0,
      truncated: false,
      reason:
        "project metadata resolution is deferred to the existing project resolver; no file read performed by the ladder itself",
    },
    budget,
    rung,
  );
}

// When a query is supplied and the brain index has been built, ranking is delegated to it
// (T-228) instead of returning the fixed authoritative-index files below. Each candidate
// path is still stat'd here (never silently truncated) before it's allowed further down the
// ladder. A query with no index built falls back to the authoritative files, with a reason
// that says so rather than silently behaving as if no query had been given.
async function planRankedReferencesViaIndex(
  query: string,
  budget: ContextBudget,
  root: string,
  indexPort: BrainIndexPort,
): Promise<BoundedReadResult | null> {
  const rung: LadderRung = "ranked-references";
  let result: Awaited<ReturnType<typeof brainSearch>>;
  try {
    result = await brainSearch({
      query,
      root,
      limit: budget.maxFiles,
      indexPort,
    });
  } catch {
    return null;
  }
  const files: string[] = [];
  let bytes = 0;
  for (const hit of result.results) {
    if (files.length >= budget.maxFiles) break;
    try {
      const size = (await stat(resolveStorePath(root, hit.path))).size;
      if (bytes + size > budget.maxBytes) break;
      files.push(storeRelativeToRoot(hit.path));
      bytes += size;
    } catch {
      // A hit whose file vanished since the index was built is skipped, not fatal.
    }
  }
  return withinCharBudget(
    {
      rung,
      files,
      bytes,
      truncated: false,
      reason: files.length
        ? `ranked by brain index (${result.mode})`
        : `brain index returned no results for query '${query}'`,
    },
    budget,
    rung,
  );
}

async function planRankedReferences(
  intent: string,
  budget: ContextBudget,
  root: string,
  query?: string,
  indexPort?: BrainIndexPort,
): Promise<BoundedReadResult> {
  const rung: LadderRung = "ranked-references";
  const cost = READ_RUNG_COST[rung];
  if (cost > budget.maxOperationCost) {
    return budgetRejection(
      rung,
      `ranked-references operation cost ${cost} exceeds budget.maxOperationCost ${budget.maxOperationCost}`,
      "max-operation-cost-exceeded",
    );
  }
  if (query && indexPort) {
    const viaIndex = await planRankedReferencesViaIndex(
      query,
      budget,
      root,
      indexPort,
    );
    if (viaIndex) return viaIndex;
    // No index built: fall through to the fixed authoritative files below, but say why.
  }
  const candidates: string[] = [];
  if (intent === "memory-lookup" || intent === "work-style-lookup")
    candidates.push(path.posix.join(PERSONAL_DIR, "MEMORY.md"));
  if (intent === "knowledge-lookup")
    candidates.push(path.posix.join(KNOWLEDGE_DIR, "KNOWLEDGE.md"));
  if (intent === "decision-lookup") {
    const directory = path.join(root, KNOWLEDGE_DIR, "decisions");
    try {
      for (const entry of (await readdir(directory, { withFileTypes: true }))
        .filter((item) => item.isFile() && item.name.endsWith(".md"))
        .sort((a, b) => a.name.localeCompare(b.name))) {
        candidates.push(
          path.posix.join(KNOWLEDGE_DIR, "decisions", entry.name),
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const files: string[] = [];
  let bytes = 0;
  for (const relative of candidates) {
    if (files.length >= budget.maxFiles) break;
    try {
      const size = (await stat(resolveWithin(root, relative))).size;
      if (bytes + size > budget.maxBytes) break;
      files.push(relative);
      bytes += size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const queryNote = query
    ? " (brain index not built — falling back to authoritative files)"
    : "";
  return withinCharBudget(
    {
      rung,
      files,
      bytes,
      truncated: false,
      reason: files.length
        ? `selected ${files.length} authoritative '${intent}' reference(s) within budget${queryNote}`
        : `no authoritative '${intent}' references were available within budget${queryNote}`,
    },
    budget,
    rung,
  );
}

// Top-level entry point reused across CLI/shim/hook/MCP callers: resolves the ladder rung
// from a slice-4 classification, validates the budget before touching anything, and stops
// immediately at the first violation with a clear, non-silent reason.
export async function planContextRead(
  classification: IntentClassification,
  budget: unknown,
  root = oceanRoot(),
  projectId = WORKSPACE_PROJECT_ID,
  options?: { query?: string; indexPort?: BrainIndexPort },
): Promise<BoundedReadResult> {
  const { rung, reason } = resolveLadderRung(classification);
  const validation = validateBudget(budget);
  if (!validation.valid)
    return budgetRejection(rung, validation.reason, "invalid-budget");
  const bounded = budget as ContextBudget;

  if (rung === "identity")
    return {
      rung,
      allowed: true,
      reason,
      violation: null,
      files: [],
      bytes: 0,
      truncated: false,
    };
  if (rung === "exact-record")
    return planExactTaskRecord(
      classification.identifier ?? "",
      bounded,
      root,
      projectId,
    );
  if (rung === "project-metadata") return planProjectMetadata(bounded);
  return planRankedReferences(
    classification.intent,
    bounded,
    root,
    options?.query,
    options?.indexPort,
  );
}
