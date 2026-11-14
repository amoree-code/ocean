import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
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

  close(): void {
    void this.#client.close().catch(() => {});
  }
}
