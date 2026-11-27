import { spawn } from "node:child_process";

// The bytes of the tool schemas Ocean's own MCP servers list to a session started in one folder
// (T-338 P5): what a client pays on every request before the user types. Measured the way a
// client sees it — a real `initialize` + `tools/list` over stdio — so profile gating and the
// core/ops split are counted, not assumed. Only Ocean's servers: a third-party entry is never
// launched by a report.

export type McpListing = { bytes: number; tools: number } | null;

// No folder in the result: a report never prints a home path.
export type McpSchemaCost = {
  ocean: McpListing;
  gateway: McpListing;
};

// One stdio server's tools/list, or null when it does not answer in time.
export function listToolBytes(
  command: string[],
  cwd: string,
  timeoutMs = 15_000,
): Promise<McpListing> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command[0], command.slice(1), {
        cwd,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolve(null);
      return;
    }
    let buffer = "";
    let settled = false;
    const finish = (value: McpListing) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        let message: { id?: unknown; result?: { tools?: unknown } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== 2) continue;
        const tools = Array.isArray(message.result?.tools)
          ? message.result.tools
          : [];
        finish({
          bytes: tools.reduce(
            (total: number, tool: unknown) =>
              total + Buffer.byteLength(JSON.stringify(tool)),
            0,
          ),
          tools: tools.length,
        });
      }
    });
    const send = (id: number, method: string, params = {}) =>
      child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    child.stdin?.on("error", () => finish(null));
    send(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "ocean-context-cost", version: "0" },
    });
    child.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    send(2, "tools/list");
  });
}

// `ocean mcp serve` and the gateway, as a client in `cwd` launches them.
export async function measureMcpSchemas(
  cwd: string,
  oceanCommand: string[],
  gatewayArgs: string[],
): Promise<McpSchemaCost> {
  const [ocean, gateway] = await Promise.all([
    listToolBytes([...oceanCommand, "mcp", "serve"], cwd),
    listToolBytes([...oceanCommand, ...gatewayArgs], cwd),
  ]);
  return { ocean, gateway };
}
