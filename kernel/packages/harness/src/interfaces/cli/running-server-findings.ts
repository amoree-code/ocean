import {
  type McpCall,
  readCallLedger,
  runningVersions,
} from "@ocean/services/infrastructure/mcp/call-ledger.js";
import { oceanVersion } from "../../version.js";

export type RunningServerFinding = {
  code: "RUNNING_STALE";
  severity: "WARN";
  message: string;
  fixable: false;
};

// `ocean doctor` (T-313): a client keeps its Ocean server process until it restarts, so after an
// upgrade it still answers with the old release. The call ledger names the release that answered
// each call; a client whose newest call came from another release than the installed one is told
// to restart.
export async function runningServerFindings(
  options: { calls?: McpCall[]; installed?: string; now?: Date } = {},
): Promise<RunningServerFinding[]> {
  const installed = options.installed ?? (await oceanVersion());
  const calls = options.calls ?? (await readCallLedger());
  return runningVersions(calls, options.now)
    .filter((row) => row.version !== installed)
    .map((row) => ({
      code: "RUNNING_STALE",
      severity: "WARN",
      message: `${row.client} last reached Ocean ${row.version} (${row.last}); ${installed} is installed: restart ${row.client}`,
      fixable: false,
    }));
}
