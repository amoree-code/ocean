import { stat } from "node:fs/promises";
import path from "node:path";
import { oceanRoot, resolveWithin } from "../../paths.js";
import {
  planContextRead,
  resolveLadderRung,
  validateBudget,
} from "./context-ladder.js";
import type {
  IntentClassification,
  IntentConfidence,
} from "./intent-router.js";
import {
  type ProjectResolution,
  resolveProject,
} from "./project-resolution.js";

// Compact context packet: the bounded, deterministic, provider-agnostic result a caller
// gets after intent-router (slice 4) classifies a request and context-ladder (slice 5)
// decides what, if anything, may be read. This slice adds no real retrieval or search —
// today at most one candidate (a single budget-approved exact-record task file) can ever
// appear in selectedReferences; ranked-reference search across memory/knowledge/tasks is
// T-198 slice 7. See T-198 slice 6.

export type RecordType =
  | "task"
  | "memory"
  | "knowledge"
  | "work-style"
  | "project"
  | "decision"
  | "execution"
  | "unknown";
export type Freshness = "current" | "stale" | "unknown";

export type SelectedReference = {
  identifier: string;
  recordType: RecordType;
  sourcePath: string;
  freshness: Freshness;
  confidence: IntentConfidence;
  selectionReason: string;
};

type ActiveProjectSummary = {
  status: "bound" | "unbound" | "ambiguous";
  projectId: string | null;
  confidence: "high" | "medium" | "low" | "none";
};

type BudgetSummary = {
  maxFiles: number | null;
  maxBytes: number | null;
  maxChars: number | null;
  maxOperationCost: number | null;
};

export type ContextPacket = {
  activeProject: ActiveProjectSummary;
  selectedReferences: SelectedReference[];
  sourcePaths: string[];
  recordTypes: RecordType[];
  freshness: Freshness;
  confidence: IntentConfidence;
  selectionReason: string;
  budget: BudgetSummary;
  violations: string[];
  // The project's hard constraints, present only when the exact-record read carried some.
  projectRules?: { project: string; rules: string[] };
};

// A file older than this is "stale", not "current" — a fixed, deterministic threshold, not
// a guess. No file read at all (nothing selected) is reported as "unknown", never "current".
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

// Hard ceiling on the packet's own serialized size, independent of the caller-supplied
// budget — a pathological input can never make the packet itself unbounded.
const PACKET_CHAR_BOUND = 8_000;

function sanitizeBudget(budget: unknown): BudgetSummary {
  const source =
    budget && typeof budget === "object"
      ? (budget as Record<string, unknown>)
      : {};
  const pick = (key: string): number | null => {
    const value = source[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  return {
    maxFiles: pick("maxFiles"),
    maxBytes: pick("maxBytes"),
    maxChars: pick("maxChars"),
    maxOperationCost: pick("maxOperationCost"),
  };
}

function activeProjectSummary(
  resolution: ProjectResolution,
): ActiveProjectSummary {
  if (resolution.status === "bound")
    return {
      status: "bound",
      projectId: resolution.projectId,
      confidence: resolution.confidence,
    };
  if (resolution.status === "ambiguous")
    return {
      status: "ambiguous",
      projectId: null,
      confidence: resolution.confidence,
    };
  return {
    status: "unbound",
    projectId: null,
    confidence: resolution.confidence,
  };
}

function recordTypeForIntent(
  intent: IntentClassification["intent"],
): RecordType {
  switch (intent) {
    case "task-lookup":
      return "task";
    case "memory-lookup":
      return "memory";
    case "knowledge-lookup":
      return "knowledge";
    case "work-style-lookup":
      return "work-style";
    case "decision-lookup":
      return "decision";
    case "project-detect":
    case "project-create":
      return "project";
    case "execute":
      return "execution";
    default:
      return "unknown";
  }
}

async function freshnessOf(
  relativeSourcePath: string,
  root = oceanRoot(),
): Promise<Freshness> {
  try {
    const resolved = resolveWithin(root, relativeSourcePath);
    const info = await stat(resolved);
    return Date.now() - info.mtimeMs <= STALE_AFTER_MS ? "current" : "stale";
  } catch {
    return "unknown";
  }
}

export type RawReferenceCandidate = {
  identifier: string;
  recordType: RecordType;
  sourcePath: string;
  freshness: Freshness;
  confidence: IntentConfidence;
  selectionReason: string;
};

// A path shape allow-list: relative, no traversal, no shell metacharacters, no null bytes.
// Existence of a file is never treated as proof a reference is valid — that check happens
// upstream (context-ladder) before a candidate ever reaches here; this function only ever
// trusts a candidate's *shape*.
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;
const UNSAFE_SEQUENCE = /[;&|`$()<>]/;

// Normalizes, validates, and deduplicates candidate references, in stable insertion order.
// Exercised directly by tests with synthetic multi-item input: the live pipeline in this
// slice only ever produces zero or one real candidate (no search yet), but this function's
// contract must already hold for slice 7, when it will receive more than one.
export function buildSelectedReferences(candidates: RawReferenceCandidate[]): {
  references: SelectedReference[];
  violations: string[];
} {
  const references: SelectedReference[] = [];
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const identifier = candidate?.identifier;
    const sourcePath = candidate?.sourcePath;
    if (!identifier || !sourcePath) {
      violations.push("reference rejected: missing identifier or sourcePath");
      continue;
    }
    if (identifier.includes("\0") || sourcePath.includes("\0")) {
      violations.push(`reference rejected: null byte in identifier or path`);
      continue;
    }
    if (path.isAbsolute(sourcePath)) {
      violations.push(
        `reference rejected: absolute path not allowed (${sourcePath})`,
      );
      continue;
    }
    if (sourcePath.split(/[\\/]/).includes("..")) {
      violations.push(
        `reference rejected: path traversal segment (${sourcePath})`,
      );
      continue;
    }
    if (UNSAFE_SEQUENCE.test(sourcePath) || UNSAFE_SEQUENCE.test(identifier)) {
      violations.push(
        `reference rejected: unsafe shell syntax in identifier or path`,
      );
      continue;
    }
    if (!SAFE_RELATIVE_PATH.test(sourcePath)) {
      violations.push(
        `reference rejected: sourcePath does not match the allowed shape (${sourcePath})`,
      );
      continue;
    }
    const key = `${identifier}::${sourcePath}`;
    if (seen.has(key)) {
      violations.push(`duplicate reference skipped: ${key}`);
      continue;
    }
    seen.add(key);
    references.push({ ...candidate });
  }
  return { references, violations };
}

function aggregateFreshness(references: SelectedReference[]): Freshness {
  if (references.length === 0) return "unknown";
  if (references.some((reference) => reference.freshness === "stale"))
    return "stale";
  if (references.some((reference) => reference.freshness === "unknown"))
    return "unknown";
  return "current";
}

function distinctRecordTypes(references: SelectedReference[]): RecordType[] {
  const types: RecordType[] = [];
  for (const reference of references)
    if (!types.includes(reference.recordType)) types.push(reference.recordType);
  return types;
}

// Top-level entry point: reuses slice 4's classification and slice 5's ladder verbatim.
// Budget is validated before any filesystem access at all — an invalid budget skips project
// resolution and the read plan entirely, so nothing is ever read on an invalid budget.
export async function buildContextPacket(
  classification: IntentClassification,
  budget: unknown,
  cwd: string = process.cwd(),
  options?: { query?: string },
): Promise<ContextPacket> {
  const budgetSummary = sanitizeBudget(budget);
  const violations: string[] = [];
  const budgetCheck = validateBudget(budget);
  if (!budgetCheck.valid)
    violations.push(`invalid-budget: ${budgetCheck.reason}`);

  const { reason: rungReason } = resolveLadderRung(classification);

  const resolution = budgetCheck.valid ? await resolveProject(cwd) : null;
  const activeProject = resolution
    ? activeProjectSummary(resolution)
    : {
        status: "unbound" as const,
        projectId: null,
        confidence: "none" as const,
      };

  const readPlan = budgetCheck.valid
    ? await planContextRead(
        classification,
        budget,
        oceanRoot(),
        // Nullable on purpose: an unbound session sees global memory only.
        activeProject.projectId,
        options,
      )
    : null;
  if (readPlan && !readPlan.allowed)
    violations.push(`${readPlan.violation ?? "rejected"}: ${readPlan.reason}`);

  let candidates: RawReferenceCandidate[] = [];
  if (readPlan?.allowed && readPlan.files.length > 0) {
    candidates = await Promise.all(
      readPlan.files.map(async (sourcePath) => ({
        identifier:
          readPlan.rung === "exact-record" && classification.identifier
            ? classification.identifier
            : path.basename(sourcePath, path.extname(sourcePath)),
        recordType: recordTypeForIntent(classification.intent),
        sourcePath,
        freshness: await freshnessOf(sourcePath, oceanRoot()),
        confidence: classification.confidence,
        selectionReason: readPlan.reason,
      })),
    );
  }

  const { references, violations: referenceViolations } =
    buildSelectedReferences(candidates);
  violations.push(...referenceViolations);

  const packet: ContextPacket = {
    activeProject,
    selectedReferences: references,
    sourcePaths: references.map((reference) => reference.sourcePath),
    recordTypes: distinctRecordTypes(references),
    freshness: aggregateFreshness(references),
    confidence: classification.confidence,
    selectionReason: readPlan ? readPlan.reason : rungReason,
    budget: budgetSummary,
    violations,
    ...(readPlan?.allowed && readPlan.rules
      ? { projectRules: readPlan.rules }
      : {}),
  };

  if (JSON.stringify(packet).length > PACKET_CHAR_BOUND) {
    return {
      ...packet,
      selectedReferences: [],
      sourcePaths: [],
      recordTypes: [],
      freshness: "unknown",
      violations: [
        ...violations,
        `packet exceeded the ${PACKET_CHAR_BOUND}-char bound and was cleared to stay bounded`,
      ],
    };
  }
  return packet;
}
