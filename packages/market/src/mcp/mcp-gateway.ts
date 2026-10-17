import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { marketplaceIndexSchema } from "@ocean/core/domain/capabilities/capability-manifest.js";
import type { McpTool } from "@ocean/core/domain/mcp/mcp-contract.js";
import { engineRoot } from "@ocean/core/shared/paths.js";
import type { McpServerSpec } from "../adapters/mcp-adapter.js";
import { scanText } from "../security/description-scan.js";
import { engineIndexFile } from "./mcp-connection.js";
import {
  type InstalledMcpServer,
  literalArguments,
  planMcpLaunch,
} from "./mcp-launch.js";

export const GATEWAY_CAPABILITY = "dev.ocean/mcp-gateway";

// One server behind the gateway: the exact process to start and the namespace its tools get.
export type GatewayMember = {
  capability: string;
  prefix: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  // First-party servers run as this Ocean, with its environment; installed ones get only the
  // variables they declared.
  inheritEnv: boolean;
};

export type GatewaySkip = { capability: string; reason: string };

// What the gateway drives for each member; `McpClient` in services satisfies it.
export type GatewayClient = {
  connect(): Promise<void>;
  listTools(): Promise<McpTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    approval: boolean,
  ): Promise<unknown>;
  close(): void;
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function namespaceFor(capability: string, taken: Set<string>): string {
  const clean = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  const short = clean(capability.split("/").at(-1) ?? capability);
  const prefix = taken.has(short) ? clean(capability) : short;
  taken.add(prefix);
  return prefix;
}

// The servers the gateway routes: the engine's first-party ones, then every MCP server installed
// from the marketplace, each planned by the same launcher as `ocean market exec` — declared
// permissions, declared environment only, inside the sandbox. A third-party server joins only by
// being installed; anything that cannot be launched here is reported, not fatal.
export async function gatewayMembers(options: {
  serversRoot: string;
  stateRoot: string;
  indexFile?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  allowUnsandboxed?: boolean;
}): Promise<{ members: GatewayMember[]; skipped: GatewaySkip[] }> {
  const members: GatewayMember[] = [];
  const skipped: GatewaySkip[] = [];
  const taken = new Set<string>();
  const notFirstParty: string[] = [];
  const index = marketplaceIndexSchema.parse(
    JSON.parse(await readFile(options.indexFile ?? engineIndexFile(), "utf8")),
  );
  for (const manifest of index.capabilities) {
    if (manifest.kind !== "mcp" || manifest.name === GATEWAY_CAPABILITY)
      continue;
    const item = (manifest.spec as McpServerSpec).packages?.[0];
    if (item?.registryType !== "ocean-engine") {
      notFirstParty.push(manifest.name);
      continue;
    }
    members.push({
      capability: manifest.name,
      prefix: namespaceFor(manifest.name, taken),
      command: process.execPath,
      args: [
        path.join(engineRoot(), "dist", "main.js"),
        ...literalArguments(
          item.packageArguments,
          `${manifest.name} packageArguments`,
        ),
      ],
      cwd: engineRoot(),
      env: {},
      inheritEnv: true,
    });
  }

  let files: string[] = [];
  try {
    files = (await readdir(options.serversRoot))
      .filter((file) => file.endsWith(".json"))
      .sort();
  } catch {
    // Nothing installed yet.
  }
  for (const file of files) {
    let installed: InstalledMcpServer;
    try {
      installed = JSON.parse(
        await readFile(path.join(options.serversRoot, file), "utf8"),
      );
    } catch (error) {
      skipped.push({ capability: file, reason: errorMessage(error) });
      continue;
    }
    const name = installed.capability;
    // An installed copy of an engine server runs the same code as the member already routed.
    if (
      name === GATEWAY_CAPABILITY ||
      members.some((member) => member.capability === name)
    )
      continue;
    const stateDir = path.join(options.stateRoot, path.basename(file, ".json"));
    try {
      const launch = planMcpLaunch(installed, {
        stateDir,
        env: options.env,
        platform: options.platform,
        allowUnsandboxed: options.allowUnsandboxed,
      });
      if (launch.transport === "remote") {
        skipped.push({
          capability: name,
          reason: `remote server (${launch.type} ${launch.url}); connect the client to it directly`,
        });
        continue;
      }
      await mkdir(stateDir, { recursive: true });
      members.push({
        capability: name,
        prefix: namespaceFor(name, taken),
        command: launch.command,
        args: launch.args,
        cwd: launch.cwd,
        env: launch.env,
        inheritEnv: false,
      });
    } catch (error) {
      skipped.push({ capability: name, reason: errorMessage(error) });
    }
  }
  for (const name of notFirstParty)
    if (!members.some((member) => member.capability === name))
      skipped.push({
        capability: name,
        reason:
          "not first-party; install it from the marketplace to route it through the gateway",
      });
  return { members, skipped };
}

// Every description a model reads for a tool: its own and each one inside its input schema.
function toolDescriptions(tool: McpTool): { at: string; text: string }[] {
  const texts = tool.description
    ? [{ at: "description", text: tool.description }]
    : [];
  const walk = (value: unknown, at: string): void => {
    if (Array.isArray(value))
      value.forEach((item, index) => {
        walk(item, `${at}[${index}]`);
      });
    else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        if (key === "description" && typeof item === "string")
          texts.push({ at: `${at}.description`, text: item });
        else walk(item, `${at}.${key}`);
      }
  };
  walk(tool.inputSchema, "inputSchema");
  return texts;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} within ${ms} ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

class GatewayError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

type Request = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
};
type Response = {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
};
type Route = { client: GatewayClient; tool: string; write: boolean };

// One MCP endpoint in front of many servers. Tools are exposed as `<prefix>__<tool>`; a tool
// whose descriptions carry injected instructions is hidden, since clients read them as prompt.
export class McpGateway {
  readonly #routes = new Map<string, Route>();
  readonly #tools: McpTool[] = [];
  readonly #clients: GatewayClient[] = [];
  #started: Promise<void> | undefined;

  constructor(
    private readonly members: GatewayMember[],
    private readonly options: {
      client: (member: GatewayMember) => GatewayClient;
      version?: string;
      timeoutMs?: number;
      log?: (line: string) => void;
    },
  ) {}

  // Starts every member at once; one that fails or hangs is left out, never the whole gateway.
  start(): Promise<void> {
    this.#started ??= this.#connectAll();
    return this.#started;
  }

  async #connectAll(): Promise<void> {
    const timeoutMs = this.options.timeoutMs ?? 15_000;
    const clients = this.members.map((member) => this.options.client(member));
    this.#clients.push(...clients);
    const results = await Promise.allSettled(
      this.members.map(async (member, index) => {
        await withTimeout(
          clients[index].connect(),
          timeoutMs,
          `${member.capability} did not start`,
        );
        return withTimeout(
          clients[index].listTools(),
          timeoutMs,
          `${member.capability} did not list its tools`,
        );
      }),
    );
    results.forEach((result, index) => {
      const member = this.members[index];
      if (result.status === "rejected") {
        this.#log(
          `${member.capability} left out: ${errorMessage(result.reason)}`,
        );
        clients[index].close();
        return;
      }
      for (const tool of result.value)
        this.#expose(member, clients[index], tool);
    });
  }

  #expose(member: GatewayMember, client: GatewayClient, tool: McpTool): void {
    const findings = toolDescriptions(tool).flatMap(({ at, text }) =>
      scanText(at, text),
    );
    if (findings.length) {
      this.#log(
        `${member.capability} tool ${tool.name} hidden: ${findings.map((finding) => `${finding.rule} in ${finding.source} ("${finding.excerpt}")`).join("; ")}`,
      );
      return;
    }
    const name = `${member.prefix}__${tool.name}`;
    if (this.#routes.has(name)) {
      this.#log(
        `${member.capability} lists ${tool.name} twice; kept the first`,
      );
      return;
    }
    this.#routes.set(name, {
      client,
      tool: tool.name,
      write: tool.annotations?.readOnlyHint === false,
    });
    this.#tools.push({ ...tool, name });
  }

  async tools(): Promise<McpTool[]> {
    await this.start();
    return [...this.#tools];
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.start();
    const route = this.#routes.get(name);
    if (!route) throw new GatewayError(-32602, `Unknown MCP tool: ${name}`);
    if (!route.write) return route.client.callTool(route.tool, args, false);
    // The rule every Ocean client applies: a tool that declares it writes runs only on an explicit
    // approval. The client then attaches the approval fingerprint the server checks.
    const { approval, ...rest } = args;
    if ((approval as { approved?: unknown } | undefined)?.approved !== true)
      throw new GatewayError(
        -32000,
        `MCP write requires explicit approval: ${name}. Once the user has confirmed, call it again with "approval": {"approved": true} in its arguments.`,
      );
    return route.client.callTool(route.tool, rest, true);
  }

  async handle(request: Request): Promise<Response | null> {
    // Notifications get no answer.
    if (request.id === undefined) return null;
    try {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: await this.#answer(request),
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: error instanceof GatewayError ? error.code : -32000,
          message: errorMessage(error),
        },
      };
    }
  }

  async #answer(request: Request): Promise<unknown> {
    switch (request.method) {
      case "initialize":
        // Members start while the client finishes its handshake.
        void this.start();
        return {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: {
            name: "ocean-gateway",
            version: this.options.version ?? "0.0.0",
          },
        };
      case "ping":
        return {};
      case "tools/list":
        return { tools: await this.tools() };
      case "tools/call": {
        const name = request.params?.name;
        if (typeof name !== "string")
          throw new GatewayError(-32602, "tools/call needs a tool name");
        return this.call(
          name,
          (request.params?.arguments ?? {}) as Record<string, unknown>,
        );
      }
      default:
        throw new GatewayError(
          -32601,
          `Unsupported MCP method: ${request.method ?? ""}`,
        );
    }
  }

  close(): void {
    for (const client of this.#clients) client.close();
  }

  #log(line: string): void {
    this.options.log?.(line);
  }
}

// Newline-delimited JSON-RPC over stdio. Requests run concurrently, so a slow tool on one server
// does not hold up another; members are stopped when the client closes the stream.
export async function serveMcpGateway(
  gateway: McpGateway,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  let buffer = "";
  const write = (response: Response | null) => {
    if (response) output.write(`${JSON.stringify(response)}\n`);
  };
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buffer += chunk;
    for (
      let newline = buffer.indexOf("\n");
      newline >= 0;
      newline = buffer.indexOf("\n")
    ) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let request: Request;
      try {
        request = JSON.parse(line) as Request;
      } catch {
        write({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
        continue;
      }
      void gateway.handle(request).then(write);
    }
  });
  await new Promise<void>((resolve) => input.once("end", resolve));
  gateway.close();
}
