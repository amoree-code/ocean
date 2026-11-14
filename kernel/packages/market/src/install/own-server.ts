import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  type CapabilityManifest,
  type CapabilityPermissions,
  capabilityNameSchema,
  type MarketplaceIndex,
  marketplaceIndexSchema,
  semverPattern,
} from "@ocean/core/domain/capabilities/capability-manifest.js";
import {
  createMcpAdapter,
  type McpServerSpec,
} from "../adapters/mcp-adapter.js";
import { contentDigest } from "../capability/content-digest.js";
import { runnerCommand } from "../mcp/mcp-launch.js";
import type {
  InstallResult,
  MarketplaceService,
} from "./marketplace-service.js";

// Names the engine ships; an owner's server may not shadow them in the owner's index, which
// wins on a name@version clash.
const RESERVED = /^dev\.ocean(\.|\/)/;

// The permissions a server.json needs to launch, exactly what the launcher checks: its runner,
// the variables its stdio package declares, or its remote's host. Nothing is added "just in case".
export function permissionsFor(server: McpServerSpec): CapabilityPermissions {
  const permissions: CapabilityPermissions = {
    filesystem: { read: [], write: [] },
    network: [],
    env: [],
    exec: [],
  };
  const stdio = server.packages?.find((item) => {
    const transport = (item.transport as { type?: unknown } | undefined)?.type;
    return transport === undefined || transport === "stdio";
  });
  if (stdio) {
    permissions.exec.push(runnerCommand(String(stdio.registryType)));
    const variables = Array.isArray(stdio.environmentVariables)
      ? (stdio.environmentVariables as { name?: unknown }[])
      : [];
    for (const variable of variables)
      if (typeof variable?.name === "string")
        permissions.env.push(variable.name);
    return permissions;
  }
  const remote = server.remotes?.[0];
  if (remote && typeof remote.url === "string" && URL.canParse(remote.url))
    permissions.network.push(new URL(remote.url).hostname);
  return permissions;
}

async function readIndex(indexFile: string): Promise<MarketplaceIndex> {
  try {
    return marketplaceIndexSchema.parse(
      JSON.parse(await readFile(indexFile, "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { schemaVersion: 1, name: "owner", capabilities: [] };
    throw error;
  }
}

// `ocean market add <server.json>`: the owner's own MCP server joins the way every other server
// does. It becomes an entry in the owner's index (`bridge/market/ocean-marketplace.json`) with
// the permissions it needs and a pinned digest, then goes through the one install path: the
// description scan, consent, the lock. If any step refuses, the entry and its payload are
// removed again, so a refused server is never installed and never started.
export async function addOwnMcpServer(options: {
  serverFile: string;
  indexFile: string;
  oceanVersion: string;
  // Built after the index is written, so the catalog reads the new entry.
  marketplace: () => MarketplaceService;
}): Promise<InstallResult> {
  const raw = JSON.parse(await readFile(options.serverFile, "utf8"));
  const server = createMcpAdapter(() => "").parseSpec(raw);
  const name = capabilityNameSchema.parse(server.name);
  if (RESERVED.test(name))
    throw new Error(`${name}: dev.ocean names are reserved for the engine`);
  const version =
    typeof server.version === "string" && semverPattern.test(server.version)
      ? server.version
      : "0.0.0";

  // The payload is the server.json itself, under a directory named by its digest so an older
  // entry's payload stays intact until the new one is installed.
  const indexDir = path.dirname(options.indexFile);
  const slug = name.replace(/[^a-z0-9._-]/g, "__");
  const ownDir = path.join(indexDir, "own");
  const staging = path.join(ownDir, `.staging-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  await writeFile(
    path.join(staging, "server.json"),
    `${JSON.stringify(server, null, 2)}\n`,
  );
  const sha256 = await contentDigest(staging);
  const payload = `${slug}-${sha256.slice(0, 12)}`;
  await rm(path.join(ownDir, payload), { recursive: true, force: true });
  await rename(staging, path.join(ownDir, payload));

  const manifest: CapabilityManifest = {
    kind: "mcp",
    name,
    version,
    description:
      "Added by the owner with `ocean market add`. A stdio server runs as an ordinary process of this user; only the variables listed here are passed to it.",
    engines: { ocean: `>=${options.oceanVersion}` },
    source: { type: "path", path: `own/${payload}` },
    integrity: { sha256 },
    permissions: permissionsFor(server),
    spec: server,
  };
  let before: string | undefined;
  try {
    before = await readFile(options.indexFile, "utf8");
  } catch {
    // No owner index yet.
  }
  const index = await readIndex(options.indexFile);
  index.capabilities = [
    ...index.capabilities.filter((entry) => entry.name !== name),
    manifest,
  ];
  await mkdir(indexDir, { recursive: true });
  await writeFile(options.indexFile, `${JSON.stringify(index, null, 2)}\n`);

  try {
    const result = await options.marketplace().install(name, version);
    // Older payloads of this server are no longer named by the index.
    for (const entry of await readdir(ownDir))
      if (entry.startsWith(`${slug}-`) && entry !== payload)
        await rm(path.join(ownDir, entry), { recursive: true, force: true });
    return result;
  } catch (error) {
    if (before === undefined) await rm(options.indexFile, { force: true });
    else await writeFile(options.indexFile, before);
    if (!before?.includes(`"own/${payload}"`))
      await rm(path.join(ownDir, payload), { recursive: true, force: true });
    throw error;
  }
}
