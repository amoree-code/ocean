import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type McpPrompt,
  type McpResource,
  type McpTool,
  mcpToolSchema,
} from "@ocean/core/domain/mcp/mcp-contract.js";
import type {
  GatewayClient,
  RemoteGatewayMember,
} from "@ocean/market/mcp/mcp-gateway.js";

// The gateway's client for a remote member (streamable HTTP or the older SSE transport).
// Redirects stay on the same origin, so a call never leaves the host the capability declared.
// Header values (tokens) come resolved from the launcher, from the environment or the secret
// store; same-origin redirects keep them from reaching another host.
export class RemoteMcpClient implements GatewayClient {
  readonly #client: Client;
  readonly #transport: StreamableHTTPClientTransport | SSEClientTransport;

  constructor(member: RemoteGatewayMember, version: string) {
    const url = new URL(member.url);
    const options = {
      redirectPolicy: "same-origin" as const,
      ...(member.headers ? { requestInit: { headers: member.headers } } : {}),
    };
    this.#transport =
      member.type === "sse"
        ? new SSEClientTransport(url, options)
        : new StreamableHTTPClientTransport(url, options);
    this.#client = new Client({ name: "ocean-gateway", version });
  }

  async connect(): Promise<void> {
    await this.#client.connect(this.#transport);
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#client.listTools(
        cursor ? { cursor } : undefined,
      );
      for (const tool of page.tools) tools.push(mcpToolSchema.parse(tool));
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  // The arguments go to the server unchanged, as for a stdio member.
  forwardToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return this.#client.callTool({ name, arguments: args });
  }

  async listResources(): Promise<McpResource[]> {
    if (!this.#client.getServerCapabilities()?.resources) return [];
    const resources: McpResource[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#client.listResources(
        cursor ? { cursor } : undefined,
      );
      resources.push(...(page.resources as McpResource[]));
      cursor = page.nextCursor;
    } while (cursor);
    return resources;
  }

  readResource(uri: string): Promise<unknown> {
    return this.#client.readResource({ uri });
  }

  async listPrompts(): Promise<McpPrompt[]> {
    if (!this.#client.getServerCapabilities()?.prompts) return [];
    const prompts: McpPrompt[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#client.listPrompts(
        cursor ? { cursor } : undefined,
      );
      prompts.push(...(page.prompts as McpPrompt[]));
      cursor = page.nextCursor;
    } while (cursor);
    return prompts;
  }

  getPrompt(name: string, args: Record<string, unknown>): Promise<unknown> {
    // MCP prompt arguments are strings; anything else is sent as its JSON text.
    const strings = Object.fromEntries(
      Object.entries(args).map(([key, value]) => [
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      ]),
    );
    return this.#client.getPrompt({ name, arguments: strings });
  }

  close(): void {
    void this.#client.close().catch(() => {});
  }
}
