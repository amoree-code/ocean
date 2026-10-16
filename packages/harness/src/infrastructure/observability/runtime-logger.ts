import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  redactRuntimeText,
  redactSecrets,
} from "@ocean/core/domain/redaction/redaction.js";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";

// Redaction is a pure domain transform; re-exported here so existing infrastructure
// callers keep importing it from the logger without reaching into domain directly.
export { redactRuntimeText, redactSecrets };

export type RuntimeLog = {
  timestamp: string;
  event: string;
  correlationId: string;
  provider?: string;
  sessionId?: string;
  status?: string;
  payload?: string;
};

export async function appendRuntimeLog(log: RuntimeLog): Promise<void> {
  const safe = {
    ...log,
    payload:
      log.payload === undefined ? undefined : redactRuntimeText(log.payload),
  };
  await mkdir(oceanPath(SYSTEM_DIR, "runtime", "logs"), { recursive: true });
  await appendFile(
    path.join(oceanPath(SYSTEM_DIR, "runtime", "logs"), "runtime.jsonl"),
    `${JSON.stringify(safe)}\n`,
    "utf8",
  );
}
