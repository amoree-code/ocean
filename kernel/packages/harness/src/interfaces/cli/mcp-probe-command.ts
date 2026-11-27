import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";

// T-339 P2 (plan §2.5): `ocean mcp probe-client` is a stdio MCP server that tells which of the
// three context layers a client supports. It lists one tool; after the first call it adds a
// second and sends `notifications/tools/list_changed`; it answers `probe_unlisted`, which it
// never lists. Every message it receives is logged, so the verdict comes from a run, not a doc.

export const PROBE_FIRST = "probe_ping";
export const PROBE_ADDED = "probe_added";
export const PROBE_UNLISTED = "probe_unlisted";

export type ProbeEntry = {
  at: string;
  method: string;
  tool?: string;
  // `tools/list` only: how many times the list had changed when the client asked.
  changes?: number;
  clientInfo?: unknown;
};

export type ProbeVerdict = {
  client?: string;
  lists: number;
  // (a) asked `tools/list` again after the list changed.
  relists: boolean;
  // (b) sent a call for a tool it was never shown.
  unlistedCall: boolean;
  calls: string[];
};

const tool = (name: string, description: string) => ({
  name,
  description,
  inputSchema: { type: "object", properties: {} },
});

export function defaultProbeLog(date = new Date()): string {
  return oceanPath(
    SYSTEM_DIR,
    "state",
    "probe",
    `probe-${date.toISOString().slice(0, 10)}.jsonl`,
  );
}

// The probe's answer to one JSON-RPC message, plus whether the list changed with it.
export function probeRespond(
  message: { id?: unknown; method?: string; params?: Record<string, unknown> },
  state: { changes: number },
): { response?: unknown; changed: boolean } {
  const reply = (result: unknown) => ({
    response: { jsonrpc: "2.0", id: message.id, result },
    changed: false,
  });
  if (message.id === undefined || message.method === undefined)
    return { changed: false };
  if (message.method === "initialize")
    return reply({
      protocolVersion:
        (message.params?.protocolVersion as string | undefined) ?? "2025-06-18",
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "ocean-probe", version: "1" },
      instructions: `Ocean probe. Call ${PROBE_FIRST} first, then ${PROBE_ADDED} if it appears, then ${PROBE_UNLISTED} even though it is not listed.`,
    });
  if (message.method === "tools/list")
    return reply({
      tools: [
        tool(PROBE_FIRST, "Probe: call this first. Returns pong."),
        ...(state.changes > 0
          ? [tool(PROBE_ADDED, "Probe: appears after the first call.")]
          : []),
      ],
    });
  if (message.method === "tools/call") {
    const name = String(message.params?.name ?? "");
    const known =
      name === PROBE_FIRST ||
      name === PROBE_UNLISTED ||
      (name === PROBE_ADDED && state.changes > 0);
    const first = state.changes === 0;
    if (first) state.changes = 1;
    return {
      response: {
        jsonrpc: "2.0",
        id: message.id,
        result: known
          ? { content: [{ type: "text", text: `${name}: ok` }] }
          : {
              isError: true,
              content: [{ type: "text", text: `unknown tool ${name}` }],
            },
      },
      changed: first,
    };
  }
  if (message.method === "ping") return reply({});
  return {
    response: {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `method not found: ${message.method}` },
    },
    changed: false,
  };
}

// Reads a probe log back into one verdict per client session (each `initialize` starts one).
export function probeVerdicts(entries: ProbeEntry[]): ProbeVerdict[] {
  const verdicts: ProbeVerdict[] = [];
  let current: ProbeVerdict | undefined;
  for (const entry of entries) {
    // Anything before the first initialize but a tool request (Claude Code's `server/discover`,
    // say) belongs to no session.
    if (
      !current &&
      entry.method !== "initialize" &&
      !entry.method.startsWith("tools/")
    )
      continue;
    if (entry.method === "initialize" || !current) {
      const info = entry.clientInfo as
        | { name?: string; version?: string }
        | undefined;
      current = {
        ...(info?.name
          ? { client: `${info.name}${info.version ? ` ${info.version}` : ""}` }
          : {}),
        lists: 0,
        relists: false,
        unlistedCall: false,
        calls: [],
      };
      verdicts.push(current);
      if (entry.method === "initialize") continue;
    }
    if (entry.method === "tools/list") {
      current.lists += 1;
      if ((entry.changes ?? 0) > 0) current.relists = true;
    }
    if (entry.method === "tools/call" && entry.tool) {
      current.calls.push(entry.tool);
      if (entry.tool === PROBE_UNLISTED) current.unlistedCall = true;
    }
  }
  return verdicts;
}

export function readProbeLog(file: string): ProbeEntry[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ProbeEntry];
      } catch {
        return [];
      }
    });
}

function serveProbe(log: string): Promise<void> {
  mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
  const state = { changes: 0 };
  const send = (message: unknown) =>
    process.stdout.write(`${JSON.stringify(message)}\n`);
  const record = (entry: ProbeEntry) =>
    appendFileSync(log, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let message: {
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.method !== "string") return;
    record({
      at: new Date().toISOString(),
      method: message.method,
      ...(message.method === "tools/call"
        ? { tool: String(message.params?.name ?? "") }
        : {}),
      ...(message.method === "tools/list" ? { changes: state.changes } : {}),
      ...(message.method === "initialize"
        ? { clientInfo: message.params?.clientInfo }
        : {}),
    });
    const { response, changed } = probeRespond(message, state);
    if (response) send(response);
    if (changed)
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  });
  return new Promise((resolve) => lines.on("close", resolve));
}

// `ocean mcp probe-client [--log <file>]` serves; `ocean mcp probe-client report [<file>]`
// prints one verdict line per client session in the log.
export async function runMcpProbeCommand(args: string[]): Promise<void> {
  const flag = args.indexOf("--log");
  const log =
    flag >= 0 && args[flag + 1] ? path.resolve(args[flag + 1]) : undefined;
  if (args[0] === "report") {
    const file =
      args[1] && !args[1].startsWith("--")
        ? path.resolve(args[1])
        : (log ?? defaultProbeLog());
    const verdicts = probeVerdicts(readProbeLog(file));
    if (args.includes("--json")) {
      console.log(JSON.stringify(verdicts, null, 2));
      return;
    }
    if (verdicts.length === 0) console.log(`no probe sessions in ${file}`);
    for (const verdict of verdicts)
      console.log(
        `${verdict.client ?? "unknown client"}: lists ${verdict.lists}; re-lists on list_changed: ${verdict.relists ? "yes" : "no"}; calls an unlisted tool: ${verdict.unlistedCall ? "yes" : "no"}; calls: ${verdict.calls.join(", ") || "none"}`,
      );
    return;
  }
  await serveProbe(log ?? defaultProbeLog());
}
