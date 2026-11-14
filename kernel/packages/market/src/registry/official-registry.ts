import {
  type McpServerSpec,
  remoteUrlAllowed,
} from "../adapters/mcp-adapter.js";
import { launchInputs, stdioPackage } from "../mcp/mcp-launch.js";

// The official MCP registry (registry.modelcontextprotocol.io): the public list of MCP servers in
// the `server.json` format Ocean installs. Read-only; nothing about the owner is sent but the
// search term. `OCEAN_MCP_REGISTRY` points at another registry with the same API (a mirror, a
// test server): https, or http on loopback.
export const OFFICIAL_REGISTRY = "https://registry.modelcontextprotocol.io";

export function registryBase(env: NodeJS.ProcessEnv = process.env): URL {
  const base = new URL(env.OCEAN_MCP_REGISTRY || OFFICIAL_REGISTRY);
  if (!remoteUrlAllowed(base))
    throw new Error(
      `OCEAN_MCP_REGISTRY ${base.href} must be https (or http on loopback)`,
    );
  return base;
}

type Entry = {
  server?: McpServerSpec;
  _meta?: Record<string, { status?: unknown } | undefined>;
};

export type RegistryHit = {
  name: string;
  version: string;
  description: string;
  status: string;
  runs: string;
  needs: string[];
};

const status = (entry: Entry) =>
  String(
    entry._meta?.["io.modelcontextprotocol.registry/official"]?.status ??
      "active",
  );

// How the server would run here: its stdio package's registry, or its remote's transport.
function runs(server: McpServerSpec): string {
  const stdio = stdioPackage(server);
  if (stdio) return String(stdio.registryType);
  const remote = server.remotes?.[0];
  return remote ? `remote ${String(remote.type ?? "streamable-http")}` : "?";
}

async function getJson(
  url: URL,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new Error(`MCP registry answered ${response.status} for ${url.href}`);
  return response.json();
}

export async function searchRegistry(
  term: string,
  options: {
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    limit?: number;
    timeoutMs?: number;
  } = {},
): Promise<RegistryHit[]> {
  const url = new URL("v0/servers", registryBase(options.env));
  url.searchParams.set("search", term);
  url.searchParams.set("limit", String(options.limit ?? 20));
  const body = (await getJson(
    url,
    options.fetch ?? fetch,
    options.timeoutMs ?? 20_000,
  )) as { servers?: Entry[] } | undefined;
  const seen = new Set<string>();
  const hits: RegistryHit[] = [];
  for (const entry of body?.servers ?? []) {
    const server = entry.server;
    if (!server || typeof server.name !== "string" || seen.has(server.name))
      continue;
    if (status(entry) === "deleted") continue;
    seen.add(server.name);
    hits.push({
      name: server.name,
      version: String(server.version ?? ""),
      description: String(server.description ?? "").slice(0, 200),
      status: status(entry),
      runs: runs(server),
      needs: launchInputs(server)
        .filter((input) => input.required)
        .map((input) => input.name),
    });
  }
  return hits;
}

// One server's `server.json`, the latest version or an exact one. A deleted entry is refused;
// a deprecated one is returned with its status so the caller can say so.
export async function fetchRegistryServer(
  name: string,
  options: {
    version?: string;
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<{ server: McpServerSpec; status: string }> {
  const url = new URL(
    `v0/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(options.version ?? "latest")}`,
    registryBase(options.env),
  );
  const entry = (await getJson(
    url,
    options.fetch ?? fetch,
    options.timeoutMs ?? 20_000,
  )) as Entry | undefined;
  if (!entry?.server)
    throw new Error(
      `${name}${options.version ? `@${options.version}` : ""} is not in the MCP registry`,
    );
  if (entry.server.name !== name)
    throw new Error(
      `the MCP registry answered ${String(entry.server.name)} for ${name}`,
    );
  if (status(entry) === "deleted")
    throw new Error(`${name} was deleted from the MCP registry`);
  return { server: entry.server, status: status(entry) };
}
