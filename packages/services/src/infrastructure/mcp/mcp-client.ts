import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  actionFingerprint,
  type McpTool,
  mcpToolSchema,
} from "@ocean/core/domain/mcp/mcp-contract.js";

type JsonRpc = {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
};
export type McpClientOptions = {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  allowedTools?: string[];
};

export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private buffer = "";
  private tools = new Map<string, McpTool>();

  constructor(private readonly options: McpClientOptions) {}

  async connect(): Promise<void> {
    this.child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: "pipe",
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.once("error", (error) => this.failPending(error));
    this.child.once("close", () =>
      this.failPending(new Error("MCP server stopped")),
    );
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "ocean", version: "0.3.2" },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.request("tools/list", {})) as {
      tools?: unknown[];
    };
    const tools = (result.tools ?? []).map((tool) => mcpToolSchema.parse(tool));
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
    return this.filterAllowed(tools);
  }

  async callTool(
    name: string,
    arguments_: Record<string, unknown> = {},
    approval = false,
  ): Promise<unknown> {
    const tool =
      this.tools.get(name) ??
      (await this.listTools()).find((candidate) => candidate.name === name);
    if (!tool)
      throw new Error(`MCP tool is not allowed or unavailable: ${name}`);
    if (!this.isAllowed(name))
      throw new Error(`MCP tool is not allowed: ${name}`);
    if (tool.annotations?.readOnlyHint === false && !approval)
      throw new Error(`MCP write requires explicit approval: ${name}`);
    const args =
      tool.annotations?.readOnlyHint === false && approval
        ? {
            ...arguments_,
            approval: {
              approved: true,
              fingerprint: actionFingerprint(name, arguments_),
            },
          }
        : arguments_;
    return this.request("tools/call", { name, arguments: args });
  }

  close(): void {
    if (this.child) {
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      this.child.kill("SIGKILL");
    }
    this.child = null;
  }

  private isAllowed(name: string): boolean {
    return (
      !this.options.allowedTools || this.options.allowedTools.includes(name)
    );
  }
  private filterAllowed(tools: McpTool[]): McpTool[] {
    return tools.filter((tool) => this.isAllowed(tool.name));
  }
  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.child?.stdin.writable)
      return Promise.reject(new Error("MCP client is not connected"));
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
  }
  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }
  private send(message: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private consume(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const response = JSON.parse(line) as JsonRpc;
      if (response.id === undefined) continue;
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      if (response.error)
        pending.reject(
          new Error(`MCP ${response.error.message ?? "request failed"}`),
        );
      else pending.resolve(response.result);
    }
  }
  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
