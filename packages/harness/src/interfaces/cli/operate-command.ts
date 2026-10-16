import { classifyIntent } from "@ocean/context/context/intent-router.js";
import { oceanRoot } from "@ocean/core/shared/paths.js";
import { knownTaskPrefixes } from "@ocean/core/shared/project-resolution.js";
import {
  type OperationName,
  operationForIntent,
} from "../../application/operations/operation-contract.js";
import { runOperation } from "../../application/operations/record-operations.js";
import {
  type GuardScope,
  guardedRunOperation,
} from "../../application/operations/write-guard.js";
import { defaultBrainIndexPort } from "../../composition/runtime.js";

const OPERATION_BUDGET = {
  maxFiles: 20,
  maxBytes: 200_000,
  maxChars: 50_000,
  maxOperationCost: 10,
};

export async function runOperateCommand(text: string): Promise<void> {
  const classification = classifyIntent(text, await knownTaskPrefixes());
  const mapped = operationForIntent(classification);
  if (!mapped.operation) {
    console.log(
      JSON.stringify({
        classification,
        operation: null,
        ok: false,
        reason: mapped.reason,
      }),
    );
    return;
  }

  const operation = mapped.operation as OperationName;
  const scope: GuardScope = {
    action: operation,
    target: oceanRoot(),
    identifier: classification.identifier ?? null,
    projectId: null,
  };
  const { decision, result } = await guardedRunOperation(
    {
      sessionId: "cli-operate",
      classification,
      scope,
      budget: OPERATION_BUDGET,
    },
    async (approval) =>
      runOperation(operation, classification, OPERATION_BUDGET, {
        cwd: process.cwd(),
        query: text,
        approval: approval ?? undefined,
        indexPort: defaultBrainIndexPort,
      }),
  );

  console.log(
    JSON.stringify({
      classification,
      operation,
      decision,
      ...(result ?? { ok: false, reason: decision.reason }),
    }),
  );
  if (
    !decision.allowed ||
    (result &&
      typeof result === "object" &&
      "ok" in result &&
      result.ok === false &&
      operation.endsWith(".write"))
  ) {
    process.exitCode = 2;
  }
}
