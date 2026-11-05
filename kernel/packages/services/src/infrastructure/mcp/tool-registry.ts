import {
  type McpTool,
  mcpToolSchema,
} from "@ocean/core/domain/mcp/mcp-contract.js";

// The tools an MCP server exposes, validated once at registration. `tools/list` and the
// `tools/call` name check both read from here, so a tool is added by registering it — there is
// no second list to keep in step.
export class McpToolRegistry<T extends McpTool = McpTool> {
  readonly #tools = new Map<string, T>();

  constructor(tools: T[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: T): void {
    const parsed = mcpToolSchema.safeParse(tool);
    if (!parsed.success)
      throw new Error(
        `Invalid MCP tool ${String((tool as { name?: unknown }).name)}: ${parsed.error.issues
          .map(
            (issue) => `${issue.path.map(String).join(".")}: ${issue.message}`,
          )
          .join("; ")}`,
      );
    if (this.#tools.has(tool.name))
      throw new Error(`MCP tool ${tool.name} is already registered`);
    this.#tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  // Registration order, which is the order clients see.
  list(): T[] {
    return [...this.#tools.values()];
  }
}
