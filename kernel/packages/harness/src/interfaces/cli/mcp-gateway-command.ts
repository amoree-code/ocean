import { mkdirSync, watch } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MEMORY_INSTRUCTIONS } from "@ocean/core/domain/mcp/memory-contract.js";
import { resolveProject } from "@ocean/core/shared/project-resolution.js";
import {
  profileCatalog,
  sessionProfile,
} from "@ocean/core/shared/session-profile.js";
import {
  readToolSelection,
  selectionPath,
} from "@ocean/core/shared/tool-groups.js";
import {
  ConnectorHub,
  connectorsForProfile,
} from "@ocean/market/connectors/connector-hub.js";
import { marketplacePaths } from "@ocean/market/install/default-marketplace.js";
import {
  type GatewayClient,
  type GatewayClientContext,
  type GatewayMember,
  type GatewayProfile,
  gatewayManifestStore,
  gatewayMembers,
  McpGateway,
  readGatewayAccess,
  serveMcpGateway,
} from "@ocean/market/mcp/mcp-gateway.js";
import { pinNpmPackage } from "@ocean/market/mcp/mcp-launch.js";
import { keychainStore } from "@ocean/market/security/secrets.js";
import { McpClient } from "@ocean/services/infrastructure/mcp/mcp-client.js";
import { RemoteMcpClient } from "../../infrastructure/mcp/remote-mcp-client.js";
import { oceanVersion } from "../../version.js";
import { connectorsDir } from "./connectors-command.js";

const OCEAN_SERVER = "dev.ocean/ocean";

// How the gateway (and `ocean mcp status --check`) talks to one member.
export function gatewayClientFor(
  member: GatewayMember,
  version: string,
  stderrLabel = `ocean mcp gateway [${member.capability}]`,
  context?: GatewayClientContext,
): GatewayClient {
  return member.transport === "remote"
    ? new RemoteMcpClient(member, version)
    : new McpClient({
        command: member.command,
        args: member.args,
        cwd: member.cwd,
        env: member.env,
        inheritEnv: member.inheritEnv,
        stderrLabel,
        ...(context ? { roots: context.roots } : {}),
        ...(context?.onListChanged
          ? {
              onNotification: (method: string) => {
                if (
                  /^notifications\/(tools|resources|prompts)\/list_changed$/.test(
                    method,
                  )
                )
                  context.onListChanged?.();
              },
            }
          : {}),
      });
}

// The profile this gateway gates by: `--profile <name>`, else the one Ocean resolves for the
// folder the client started it in (Claude Code: the project; Desktop: `/`, which resolves to
// base). `--profile '*'`: no gating. The active profile carries its secondary profiles' MCPs
// too, as the session does. No installed profiles: no gating.
async function gatewayProfiles(
  args: string[],
  cwd: string,
): Promise<
  { active: GatewayProfile; available: GatewayProfile[] } | undefined
> {
  const asked = args.includes("--profile")
    ? args[args.indexOf("--profile") + 1]
    : undefined;
  if (asked === "*") return undefined;
  const catalog = await profileCatalog();
  // No profiles installed: nothing to gate by, so every member stays listed.
  if (!catalog.profiles.length) return undefined;
  // An MCP connector entry joins a profile's members only where the profile uses it (T-339 P3).
  const { rows } = await new ConnectorHub(connectorsDir()).list();
  const available = catalog.profiles.map((profile) => ({
    name: profile.name,
    mcp: [
      ...new Set([
        ...profile.mcp,
        ...connectorsForProfile(rows, profile)
          .filter(
            (entry) =>
              entry.kind === "mcp-stdio" || entry.kind === "mcp-remote",
          )
          .map((entry) => entry.id),
      ]),
    ],
  }));
  const mcpOf = (name: string) =>
    available.find((profile) => profile.name === name)?.mcp ?? [];
  if (asked) return { active: { name: asked, mcp: mcpOf(asked) }, available };
  const atRoot = cwd === "/" || /^[A-Za-z]:\\?$/.test(cwd);
  const project = atRoot
    ? undefined
    : await resolveProject(cwd).catch(() => undefined);
  const session = await sessionProfile({
    projectId: project?.status === "bound" ? project.projectId : undefined,
    cwd: atRoot ? undefined : cwd,
    catalog,
  });
  const names = [session.primary, ...session.secondary];
  return {
    active: {
      name: session.primary,
      mcp: [...new Set(names.flatMap(mcpOf))],
    },
    available,
  };
}

// `ocean mcp gateway`: one stdio MCP endpoint for every registered server. Logs go to stderr,
// which MCP clients keep as the server's log.
// `--installed-only`: leave out Ocean's own servers, for a client wired to them directly.
// `--client <id>`: the client this process serves, for the access rules.
export async function runMcpGatewayCommand(args: string[] = []): Promise<void> {
  const log = (line: string) => console.error(`ocean mcp gateway: ${line}`);
  const paths = marketplacePaths();
  const firstParty = !args.includes("--installed-only");
  const { members, skipped } = await gatewayMembers({
    serversRoot: paths.mcpServers,
    stateRoot: paths.mcpState,
    packagesRoot: paths.mcpPackages,
    firstParty,
    secrets: keychainStore(),
  });
  // Ocean's own servers left out on purpose (`--installed-only`) are not news; anything else is.
  for (const skip of skipped)
    if (!skip.uninstalled) log(`${skip.capability} not routed: ${skip.reason}`);
  const version = await oceanVersion();
  const cwd = process.cwd();
  const atRoot = cwd === "/" || /^[A-Za-z]:\\?$/.test(cwd);
  const profiles = await gatewayProfiles(args, cwd).catch((error) => {
    log(
      `profiles unreadable, every member listed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  });
  const pinning = new Set<string>();
  const gateway = new McpGateway(members, {
    client: (member, context) => {
      // A member still on npx gets a pinned copy in the background; the next start uses it.
      if (member.transport !== "remote" && member.pin) {
        const { identifier, version: pinned } = member.pin;
        const key = `${identifier}@${pinned}`;
        if (!pinning.has(key)) {
          pinning.add(key);
          pinNpmPackage(paths.mcpPackages, identifier, pinned).then(
            () => log(`${key} pinned; the next start skips npx`),
            (error: unknown) =>
              log(
                `${key} not pinned: ${error instanceof Error ? error.message : String(error)}`,
              ),
          );
        }
      }
      return gatewayClientFor(
        member,
        version,
        `ocean mcp gateway [${member.capability}]`,
        context,
      );
    },
    version,
    log,
    // When Ocean's own server sits behind the gateway and this client may see it, the client
    // gets Ocean's memory contract in `initialize`, as on a direct connection (T-313).
    ...(firstParty
      ? { instructions: MEMORY_INSTRUCTIONS, instructionsMember: OCEAN_SERVER }
      : {}),
    access: await readGatewayAccess(paths.gatewayAccess),
    clientId: args.includes("--client")
      ? args[args.indexOf("--client") + 1]
      : undefined,
    ...(profiles ? { profiles } : {}),
    // Ocean's memory contract holds in every profile.
    ungated: [OCEAN_SERVER],
    manifests: gatewayManifestStore(paths.gatewayManifests, version),
    ...(atRoot ? {} : { roots: [{ uri: pathToFileURL(cwd).href }] }),
  });
  // A gateway started without `--profile` follows the prompt hook's selection for its folder.
  if (profiles && !args.includes("--profile") && !atRoot)
    followToolSelection(gateway, cwd, log);
  await serveMcpGateway(gateway);
}

// Watches the selection file the prompt hook writes for this folder (debounced) and widens the
// gateway's profile to it. Best effort: a missing directory or a failed read changes nothing.
function followToolSelection(
  gateway: McpGateway,
  cwd: string,
  log: (line: string) => void,
): void {
  const file = selectionPath(cwd);
  let timer: NodeJS.Timeout | undefined;
  const apply = () =>
    void readToolSelection(cwd)
      .then((selection) =>
        selection ? gateway.followSelection(selection) : false,
      )
      .catch((error: unknown) =>
        log(
          `selection not followed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const watcher = watch(path.dirname(file), (_event, name) => {
      if (name !== path.basename(file)) return;
      clearTimeout(timer);
      timer = setTimeout(apply, 250);
      timer.unref();
    });
    watcher.unref();
  } catch {}
  apply();
}
