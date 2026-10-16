import type { SessionStorePort } from "@ocean/core/domain/ports/session-store-port.js";
import {
  assertRunCanStart,
  type RunContract,
} from "@ocean/core/domain/runs/run-contract.js";

export function authorizeRun(
  store: SessionStorePort,
  contract: RunContract,
  attempt = 1,
): void {
  try {
    const session = store.get(contract.sessionId);
    if (!session)
      throw new Error(`Run contract session not found: ${contract.sessionId}`);
    if (session.profile !== contract.profile)
      throw new Error("Run contract profile does not match the session");
    if (session.workingDirectory !== contract.workingDirectory)
      throw new Error(
        "Run contract working directory does not match the session",
      );
    assertRunCanStart(contract, attempt);
    store.appendEvent(
      contract.sessionId,
      "run_approval",
      JSON.stringify({ runId: contract.runId, approved: true, attempt }),
    );
  } catch (error) {
    store.appendEvent(
      contract.sessionId,
      "run_refusal",
      JSON.stringify({
        runId: contract.runId,
        approved: false,
        reason: error instanceof Error ? error.message : String(error),
        attempt,
      }),
    );
    throw error;
  }
}
