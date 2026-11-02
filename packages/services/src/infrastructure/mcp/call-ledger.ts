import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "@ocean/core/shared/fs-utils.js";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";

// The MCP call ledger (T-307): proof, from Ocean's side, that a client's model actually used a
// tool. One line per call holds exactly {ts, client, tool, ok} — never the arguments, the
// result, the question or any record content. Owner-only, kept 90 days.

export type McpCall = { ts: string; client: string; tool: string; ok: boolean };

export const CALL_LEDGER_RETENTION_DAYS = 90;
// Past this size the oldest half goes, whatever its age.
const MAX_LEDGER_BYTES = 2_000_000;
const DAY_MS = 86_400_000;

const NAME = /^[\w .@/-]{1,64}$/;

export function callLedgerFile(): string {
  return oceanPath(SYSTEM_DIR, "state", "mcp", "calls.jsonl");
}

// Built field by field so nothing else a caller holds can reach the file.
export function ledgerLine(
  client: string,
  tool: string,
  ok: boolean,
  now = new Date(),
): string {
  const call: McpCall = {
    ts: now.toISOString(),
    client: NAME.test(client) ? client : "unknown",
    tool: NAME.test(tool) ? tool : "unknown",
    ok: ok === true,
  };
  return `${JSON.stringify(call)}\n`;
}

export async function readCallLedger(): Promise<McpCall[]> {
  let text: string;
  try {
    text = await readFile(callLedgerFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const calls: McpCall[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      calls.push(JSON.parse(line) as McpCall);
    } catch {
      // A torn line from a crash is skipped, not fatal.
    }
  }
  return calls;
}

export type CallSummary = {
  client: string;
  tool: string;
  calls: number;
  ok: number;
  last: string;
};

// Per client and tool: how often, how often it succeeded, and when last.
export function summarizeCallLedger(calls: McpCall[]): CallSummary[] {
  const rows = new Map<string, CallSummary>();
  for (const call of calls) {
    const key = `${call.client}\u0000${call.tool}`;
    const row = rows.get(key) ?? {
      client: call.client,
      tool: call.tool,
      calls: 0,
      ok: 0,
      last: call.ts,
    };
    row.calls += 1;
    if (call.ok) row.ok += 1;
    if (call.ts > row.last) row.last = call.ts;
    rows.set(key, row);
  }
  return [...rows.values()].sort(
    (a, b) => a.client.localeCompare(b.client) || a.tool.localeCompare(b.tool),
  );
}

// Drops lines older than the retention, then the oldest half while still over the size cap.
export function pruneLedgerText(text: string, now = new Date()): string {
  const cutoff = now.getTime() - CALL_LEDGER_RETENTION_DAYS * DAY_MS;
  let lines = text.split("\n").filter((line) => {
    if (!line) return false;
    try {
      const ts = Date.parse((JSON.parse(line) as McpCall).ts);
      return Number.isFinite(ts) && ts >= cutoff;
    } catch {
      return false;
    }
  });
  while (
    lines.length > 1 &&
    Buffer.byteLength(lines.join("\n")) > MAX_LEDGER_BYTES
  )
    lines = lines.slice(Math.floor(lines.length / 2));
  return lines.length ? `${lines.join("\n")}\n` : "";
}

let prunedThisProcess = false;

// Never throws: a ledger problem must not fail the tool call it records.
export async function recordMcpCall(
  client: string,
  tool: string,
  ok: boolean,
  now = new Date(),
): Promise<void> {
  const file = callLedgerFile();
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await withFileLock(file, async () => {
      await appendFile(file, ledgerLine(client, tool, ok, now), {
        mode: 0o600,
      });
      const size = (await stat(file)).size;
      if (prunedThisProcess && size <= MAX_LEDGER_BYTES) return;
      prunedThisProcess = true;
      const text = await readFile(file, "utf8");
      const kept = pruneLedgerText(text, now);
      if (kept !== text) await writeFile(file, kept, { mode: 0o600 });
    });
  } catch {
    // Best effort only.
  }
}

// Tests run many workspaces in one process.
export function resetCallLedgerForTests(): void {
  prunedThisProcess = false;
}
