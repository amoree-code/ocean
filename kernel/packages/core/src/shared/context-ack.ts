import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "./fs-utils.js";
import { oceanPath, SYSTEM_DIR } from "./paths.js";

// CONTEXT-ACK (T-319, borrowed from forge): the Ocean start line carries a short hash of itself,
// and a client echoes it as `contextAck` on its first Ocean tool call. An echo of a hash Ocean
// actually handed out is the recorded answer to "did this client load Ocean?". The issued file
// holds only hashes and when each was last handed out — never the line itself.

const ISSUED_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const ACK = /^[0-9a-f]{8}$/;

export function contextAck(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

export function contextAckFile(): string {
  return oceanPath(SYSTEM_DIR, "state", "mcp", "context-acks.json");
}

async function readIssued(): Promise<Record<string, string>> {
  try {
    const value = JSON.parse(await readFile(contextAckFile(), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

// Never throws: a start line is delivered whether or not its hash could be noted.
export async function recordIssuedAck(
  ack: string,
  now = new Date(),
): Promise<void> {
  if (!ACK.test(ack)) return;
  const file = contextAckFile();
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await withFileLock(file, async () => {
      const cutoff = now.getTime() - ISSUED_RETENTION_DAYS * DAY_MS;
      const issued = Object.fromEntries(
        Object.entries(await readIssued()).filter(
          ([hash, ts]) => ACK.test(hash) && Date.parse(ts) >= cutoff,
        ),
      );
      issued[ack] = now.toISOString();
      await writeFile(file, `${JSON.stringify(issued)}\n`, { mode: 0o600 });
    });
  } catch {
    // Best effort only.
  }
}

export async function ackIssued(ack: unknown): Promise<boolean> {
  return (
    typeof ack === "string" && ACK.test(ack) && ack in (await readIssued())
  );
}
