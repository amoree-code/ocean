import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { engineRoot, oceanRoot, resolveWithin } from "../../paths.js";
import { validateBudget } from "../context/context-ladder.js";
import type { IntentClassification } from "../context/intent-router.js";
import {
  OPERATION_KIND,
  type OperationName,
  type WriteApproval,
} from "./operation-contract.js";

// Central write guard (T-198 slice 9). Every durable write, command execution, and provider
// invocation must pass through evaluateGuard() first. Approval is never inferred from what
// the user typed: it exists only as an explicit grant object bound to one session, one
// action, one target, and one scope hash, with an explicit expiry. Defaults are closed.

type GuardAction = OperationName | "execute.command" | "provider.invoke";

export type ConsentState = "none" | "granted" | "revoked" | "expired";

export type ApprovalGrant = {
  grantId: string;
  sessionId: string;
  action: GuardAction;
  target: string;
  scopeHash: string;
  grantedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  consumed: boolean;
};

export type GuardScope = {
  action: GuardAction;
  target: string;
  identifier: string | null;
  projectId: string | null;
};

type GuardDenialCode =
  | "allowed"
  | "invalid-budget"
  | "invalid-target"
  | "unknown-intent"
  | "ambiguous-intent"
  | "low-confidence"
  | "no-consent"
  | "consent-revoked"
  | "consent-expired"
  | "consent-consumed"
  | "wrong-session"
  | "wrong-action"
  | "wrong-target"
  | "scope-changed";

// Audit metadata only: ids, action, target, hash, decision. Never the request text, never
// record content, never credentials.
type GuardAudit = {
  action: GuardAction;
  target: string;
  sessionId: string;
  scopeHash: string;
  intent: string;
  confidence: string;
  code: GuardDenialCode;
  decidedAt: string;
};

export type GuardDecision = {
  allowed: boolean;
  code: GuardDenialCode;
  reason: string;
  consent: ConsentState;
  audit: GuardAudit;
  approval: WriteApproval | null;
};

const DEFAULT_GRANT_TTL_MS = 15 * 60 * 1000;

// A grant is bound to the exact scope it was granted for. Any change to the action, the
// resolved target, the record identifier, or the project produces a different hash, so a
// reused grant cannot silently cover a different write.
export function computeScopeHash(scope: GuardScope): string {
  const canonical = JSON.stringify({
    action: scope.action,
    target: path.resolve(scope.target),
    identifier: scope.identifier ?? null,
    projectId: scope.projectId ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export function createGrant(
  sessionId: string,
  scope: GuardScope,
  options: { now?: number; ttlMs?: number } = {},
): ApprovalGrant {
  const now = options.now ?? Date.now();
  return {
    grantId: randomUUID(),
    sessionId,
    action: scope.action,
    target: path.resolve(scope.target),
    scopeHash: computeScopeHash(scope),
    grantedAt: new Date(now).toISOString(),
    expiresAt: new Date(
      now + (options.ttlMs ?? DEFAULT_GRANT_TTL_MS),
    ).toISOString(),
    revokedAt: null,
    consumed: false,
  };
}

export function revokeGrant(
  grant: ApprovalGrant,
  now = Date.now(),
): ApprovalGrant {
  return { ...grant, revokedAt: new Date(now).toISOString() };
}

export function consentStateOf(
  grant: ApprovalGrant | null | undefined,
  now = Date.now(),
): ConsentState {
  if (!grant) return "none";
  if (grant.revokedAt) return "revoked";
  if (Date.parse(grant.expiresAt) <= now) return "expired";
  return "granted";
}

export type GuardRequest = {
  sessionId: string;
  classification: IntentClassification;
  scope: GuardScope;
  budget: unknown;
  grant?: ApprovalGrant | null;
  now?: number;
};

function decision(
  request: GuardRequest,
  code: GuardDenialCode,
  reason: string,
  consent: ConsentState,
  scopeHash: string,
  approval: WriteApproval | null = null,
): GuardDecision {
  return {
    allowed: code === "allowed",
    code,
    reason,
    consent,
    approval,
    audit: {
      action: request.scope.action,
      target: path.resolve(request.scope.target),
      sessionId: request.sessionId,
      scopeHash,
      intent: request.classification.intent,
      confidence: request.classification.confidence,
      code,
      decidedAt: new Date(request.now ?? Date.now()).toISOString(),
    },
  };
}

// The one decision function. Read operations pass straight through (they are bounded
// elsewhere); every write, execution, and provider invocation is evaluated here.
export function evaluateGuard(request: GuardRequest): GuardDecision {
  const now = request.now ?? Date.now();
  const scopeHash = computeScopeHash(request.scope);
  const consent = consentStateOf(request.grant, now);

  const budgetCheck = validateBudget(request.budget);
  if (!budgetCheck.valid)
    return decision(
      request,
      "invalid-budget",
      `denied: ${budgetCheck.reason}`,
      consent,
      scopeHash,
    );

  const isRecordOperation = request.scope.action in OPERATION_KIND;
  const needsApproval =
    !isRecordOperation ||
    OPERATION_KIND[request.scope.action as OperationName] === "write";
  if (!needsApproval) {
    return decision(
      request,
      "allowed",
      "read operation: no approval required",
      consent,
      scopeHash,
      null,
    );
  }

  if (request.classification.intent === "unknown") {
    return decision(
      request,
      "unknown-intent",
      "denied: unknown intent may never write, execute, or invoke a provider",
      consent,
      scopeHash,
    );
  }
  if (request.classification.ambiguityReason) {
    return decision(
      request,
      "ambiguous-intent",
      `denied: ambiguous intent may never write, execute, or invoke a provider (${request.classification.ambiguityReason})`,
      consent,
      scopeHash,
    );
  }
  if (request.classification.confidence !== "high") {
    return decision(
      request,
      "low-confidence",
      `denied: confidence '${request.classification.confidence}' is below the required 'high'`,
      consent,
      scopeHash,
    );
  }

  if (request.scope.target.includes("\0")) {
    return decision(
      request,
      "invalid-target",
      "denied: target contains a null byte",
      consent,
      scopeHash,
    );
  }
  // A record write must resolve inside the private Ocean root and never inside the public
  // engine package, whatever path the caller passed. resolveWithin (paths.js) rejects both a
  // lexical escape and a symlink that resolves outside the given root, so a symlink planted
  // inside the Ocean root pointing outside it can't be used to land a write elsewhere.
  if (isRecordOperation) {
    const resolved = path.resolve(request.scope.target);
    try {
      resolveWithin(oceanRoot(), resolved);
    } catch {
      return decision(
        request,
        "invalid-target",
        "denied: target escapes the Ocean root",
        consent,
        scopeHash,
      );
    }
    let insideEngine = true;
    try {
      resolveWithin(engineRoot(), resolved);
    } catch {
      insideEngine = false;
    }
    if (insideEngine) {
      return decision(
        request,
        "invalid-target",
        "denied: refusing to write private Ocean content inside the public engine package",
        consent,
        scopeHash,
      );
    }
  }

  if (consent === "none")
    return decision(
      request,
      "no-consent",
      "denied: no explicit approval grant was supplied — approval is never inferred from wording",
      consent,
      scopeHash,
    );
  if (consent === "revoked")
    return decision(
      request,
      "consent-revoked",
      "denied: the approval grant was revoked",
      consent,
      scopeHash,
    );
  if (consent === "expired")
    return decision(
      request,
      "consent-expired",
      "denied: the approval grant has expired",
      consent,
      scopeHash,
    );

  const grant = request.grant as ApprovalGrant;
  if (grant.consumed)
    return decision(
      request,
      "consent-consumed",
      "denied: the approval grant was already used and is not reusable",
      consent,
      scopeHash,
    );
  if (grant.sessionId !== request.sessionId) {
    return decision(
      request,
      "wrong-session",
      `denied: the approval grant belongs to session ${grant.sessionId}, not ${request.sessionId} — approval is never inherited`,
      consent,
      scopeHash,
    );
  }
  if (grant.action !== request.scope.action) {
    return decision(
      request,
      "wrong-action",
      `denied: the approval grant covers '${grant.action}', not '${request.scope.action}'`,
      consent,
      scopeHash,
    );
  }
  if (path.resolve(grant.target) !== path.resolve(request.scope.target)) {
    return decision(
      request,
      "wrong-target",
      `denied: the approval grant covers a different target`,
      consent,
      scopeHash,
    );
  }
  if (grant.scopeHash !== scopeHash) {
    return decision(
      request,
      "scope-changed",
      "denied: the request scope changed after the approval was granted",
      consent,
      scopeHash,
    );
  }

  const approval: WriteApproval | null = isRecordOperation
    ? {
        approved: true,
        operation: request.scope.action as OperationName,
        target: path.resolve(request.scope.target),
      }
    : null;
  return decision(
    request,
    "allowed",
    `approved: grant ${grant.grantId} covers this exact action, target, and scope`,
    consent,
    scopeHash,
    approval,
  );
}

// Marks a grant used. A grant is single-use, so an approved write cannot be replayed.
export function consumeGrant(grant: ApprovalGrant): ApprovalGrant {
  return { ...grant, consumed: true };
}

// The single sanctioned write path: guard first, operation second. A caller that skips this
// still hits slice 7's own approval check, which only accepts the approval object the guard
// produces — there is no path to a durable write that bypasses both.
export async function guardedRunOperation(
  request: GuardRequest,
  run: (approval: WriteApproval | null) => Promise<unknown>,
): Promise<{ decision: GuardDecision; result: unknown | null }> {
  const verdict = evaluateGuard(request);
  if (!verdict.allowed) return { decision: verdict, result: null };
  return { decision: verdict, result: await run(verdict.approval) };
}
