import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { marketplaceIndexSchema } from "@ocean/core/domain/capabilities/capability-manifest.js";
import type {
  McpPrompt,
  McpResource,
  McpTool,
} from "@ocean/core/domain/mcp/mcp-contract.js";
import { engineRoot } from "@ocean/core/shared/paths.js";
import type { McpServerSpec } from "../adapters/mcp-adapter.js";
import { scanText } from "../security/description-scan.js";
import type { SecretStore } from "../security/secrets.js";
import { engineIndexFile } from "./mcp-connection.js";
import {
  type InstalledMcpServer,
  literalArguments,
  planMcpLaunch,
  type RemoteTransport,
} from "./mcp-launch.js";

export const GATEWAY_CAPABILITY = "dev.ocean/mcp-gateway";
// The gateway's own tools use this namespace, so no member may take it.
export const GATEWAY_PREFIX = "gateway";
export const PROFILE_TOOL = `${GATEWAY_PREFIX}__use_profile`;

// One server behind the gateway and the namespace its tools get: either the exact process to
// start, or a remote endpoint to connect to.
export type GatewayMember = StdioGatewayMember | RemoteGatewayMember;

type MemberBase = {
  capability: string;
  prefix: string;
  // Set when the server is hidden unless a client is allowed it by name: why (it writes files,
  // it controls a browser).
  sensitive?: string;
};

export type RemoteGatewayMember = MemberBase & {
  transport: "remote";
  type: RemoteTransport;
  url: string;
  // Resolved header values: in memory only, never logged.
  headers?: Record<string, string>;
};

export type StdioGatewayMember = MemberBase & {
  transport?: "stdio";
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  // First-party servers run as this Ocean, with its environment; installed ones get only the
  // variables they declared.
  inheritEnv: boolean;
  // An npm package started through npx because it has no local copy yet: the gateway installs
  // that exact version under `bridge/market/packages` on first use, and later starts run it
  // with node directly (T-338 P4).
  pin?: { identifier: string; version: string };
};

// `uninstalled`: an index entry nobody installed. That is reported by `ocean mcp status`, not
// logged on every gateway start.
export type GatewaySkip = {
  capability: string;
  reason: string;
  uninstalled?: boolean;
};

export type McpRoot = { uri: string; name?: string };
// What the gateway hands a member's client: the roots it may forward to the member.
export type GatewayClientContext = { roots: () => Promise<McpRoot[]> };

// The profile a gateway serves (T-338 P4, plan §3.4): a member is listed only when the
// profile's `mcp` names it, by capability (`dev.ocean/chrome-devtools`), by its last segment
// (`chrome-devtools`) or by its prefix.
export type GatewayProfile = { name: string; mcp: string[] };

export function profileAllows(
  profile: GatewayProfile,
  member: Pick<GatewayMember, "capability" | "prefix">,
): boolean {
  const short = member.capability.split("/").at(-1) ?? member.capability;
  return profile.mcp.some(
    (name) =>
      name === member.capability || name === short || name === member.prefix,
  );
}

// A member's tools, resources and prompts as it listed them, before namespacing.
export type GatewayListing = {
  tools: McpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
};

// Cached listings, so a member is listed without starting it (T-338 P4, plan §3.5).
export type GatewayManifestStore = {
  read(member: GatewayMember): Promise<GatewayListing | undefined>;
  write(member: GatewayMember, listing: GatewayListing): Promise<void>;
};

// One file per member under `dir`. The key covers how the member is started and Ocean's
// version, so an update, a new pinned version or another launch plan lists it afresh. Env
// values and headers are left out of the key: they may hold secrets and do not change a
// server's tools.
export function gatewayManifestStore(
  dir: string,
  version: string,
): GatewayManifestStore {
  const keyOf = (member: GatewayMember) =>
    createHash("sha256")
      .update(
        JSON.stringify(
          member.transport === "remote"
            ? [version, member.capability, member.type, member.url]
            : [version, member.capability, member.command, member.args],
        ),
      )
      .digest("hex");
  const fileOf = (member: GatewayMember) =>
    path.join(
      dir,
      `${member.capability.toLowerCase().replace(/[^a-z0-9_-]+/g, "_")}.json`,
    );
  return {
    async read(member) {
      try {
        const saved = JSON.parse(await readFile(fileOf(member), "utf8"));
        if (saved?.key !== keyOf(member)) return undefined;
        const listing = saved.listing;
        if (!Array.isArray(listing?.tools)) return undefined;
        return {
          tools: listing.tools,
          resources: Array.isArray(listing.resources) ? listing.resources : [],
          prompts: Array.isArray(listing.prompts) ? listing.prompts : [],
        };
      } catch {
        return undefined;
      }
    },
    async write(member, listing) {
      await mkdir(dir, { recursive: true });
      const file = fileOf(member);
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(
        temporary,
        `${JSON.stringify({ key: keyOf(member), listing }, null, 2)}\n`,
      );
      await rename(temporary, file);
    },
  };
}

// One-line hints for the browser errors seen most in transcripts (plan §2): a page lost after a
// reconnect, and element uids from a snapshot taken before the page changed.
const ERROR_HINTS: [RegExp, string][] = [
  [
    /No page found|Page ids have changed|Target closed|No page selected/i,
    "Hint: the browser reconnected or the page closed; call list_pages, then select_page, and retry.",
  ],
  [
    /uid "?[^"\s]*"? not found/i,
    "Hint: the page changed since the last snapshot; call take_snapshot for fresh uids, then retry.",
  ],
];

export function errorHint(text: string): string | undefined {
  return ERROR_HINTS.find(([pattern]) => pattern.test(text))?.[1];
}

// A failed tool result gets the hint as one more text block; a successful one is untouched.
function withHint(result: unknown): unknown {
  if (!isRecord(result) || result.isError !== true) return result;
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((item) =>
      isRecord(item) && typeof item.text === "string" ? item.text : "",
    )
    .join("\n");
  const hint = errorHint(text);
  return hint
    ? { ...result, content: [...content, { type: "text", text: hint }] }
    : result;
}

// What the gateway drives for each member; `McpClient` in services satisfies it.
export type GatewayClient = {
  connect(): Promise<void>;
  listTools(): Promise<McpTool[]>;
  forwardToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  // Resources and prompts are optional: a member without them (or a client that cannot ask) has
  // none, and the gateway still routes its tools.
  listResources?(): Promise<McpResource[]>;
  readResource?(uri: string): Promise<unknown>;
  listPrompts?(): Promise<McpPrompt[]>;
  getPrompt?(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): void;
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function namespaceFor(capability: string, taken: Set<string>): string {
  const clean = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  const short = clean(capability.split("/").at(-1) ?? capability);
  let prefix = taken.has(short) ? clean(capability) : short;
  for (let suffix = 2; taken.has(prefix); suffix++)
    prefix = `${clean(capability)}-${suffix}`;
  taken.add(prefix);
  return prefix;
}

const BROWSER =
  /(^|[^a-z])(browser|chrome|chromium|devtools|playwright|puppeteer|selenium|webdriver)([^a-z]|$)/i;

// Why an installed server is hidden from a client that was not allowed it by name, or nothing.
// Declared file writes count; so does driving a browser, recognised by name, since a browser
// server reads and acts inside every signed-in session whatever it declares.
export function sensitivityOf(
  installed: InstalledMcpServer,
): string | undefined {
  if (installed.permissions.filesystem.write.length) return "writes files";
  const names = [
    installed.capability,
    ...(installed.server.packages ?? []).map((item) => String(item.identifier)),
  ];
  if (names.some((name) => BROWSER.test(name))) return "controls a browser";
  return undefined;
}

// Which installed servers each MCP client may see, by the name it gives in `initialize`
// (`clientInfo.name`). Missing from `bridge/market/gateway-access.json` means: every server that
// is not sensitive. `allow` adds sensitive ones (or `"*"` for all), `deny` removes any.
export type GatewayAccess = {
  clients: Record<string, { allow?: string[]; deny?: string[] }>;
};

export function canSee(
  access: GatewayAccess,
  client: string | undefined,
  member: GatewayMember,
): boolean {
  const rule = client === undefined ? undefined : access.clients[client];
  if (rule?.deny?.includes(member.capability)) return false;
  if (!member.sensitive) return true;
  return Boolean(
    rule?.allow?.includes(member.capability) || rule?.allow?.includes("*"),
  );
}

// `ocean clients allow|deny|unset <client> <capability>`: one rule changed, the rest kept.
export async function updateGatewayAccess(
  file: string,
  client: string,
  capability: string,
  change: "allow" | "deny" | "unset",
): Promise<GatewayAccess> {
  const access = await readGatewayAccess(file);
  const rule = access.clients[client] ?? {};
  const without = (list?: string[]) =>
    (list ?? []).filter((item) => item !== capability);
  const next = { allow: without(rule.allow), deny: without(rule.deny) };
  if (change === "allow") next.allow.push(capability);
  if (change === "deny") next.deny.push(capability);
  if (next.allow.length || next.deny.length)
    access.clients[client] = {
      ...(next.allow.length ? { allow: next.allow.sort() } : {}),
      ...(next.deny.length ? { deny: next.deny.sort() } : {}),
    };
  else delete access.clients[client];
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(access, null, 2)}\n`);
  await rename(temp, file);
  return access;
}

export async function readGatewayAccess(file: string): Promise<GatewayAccess> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { clients: {} };
    throw new Error(`Cannot read ${file}: ${errorMessage(error)}`);
  }
  const clients = isRecord(raw) ? raw.clients : undefined;
  const list = (value: unknown) =>
    value === undefined ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"));
  if (
    !isRecord(clients) ||
    !Object.values(clients).every(
      (rule) => isRecord(rule) && list(rule.allow) && list(rule.deny),
    )
  )
    throw new Error(
      `${file}: expected {"clients": {"<client name>": {"allow": [...], "deny": [...]}}}`,
    );
  return raw as GatewayAccess;
}

// The servers the gateway routes: the engine's first-party ones, then every MCP server installed
// from the marketplace, each planned by the same launcher as `ocean market exec` — declared
// permissions, declared environment only. A third-party server joins only by
// being installed; anything that cannot be launched here is reported, not fatal.
export async function gatewayMembers(options: {
  serversRoot: string;
  stateRoot: string;
  indexFile?: string;
  env?: NodeJS.ProcessEnv;
  // false: installed servers only, for a client that already has Ocean's own servers directly.
  firstParty?: boolean;
  // Where secret values come from after the environment (default: none).
  secrets?: SecretStore;
  // Where pinned npm packages live (`bridge/market/packages`); unset: always npx.
  packagesRoot?: string;
}): Promise<{ members: GatewayMember[]; skipped: GatewaySkip[] }> {
  const members: GatewayMember[] = [];
  const skipped: GatewaySkip[] = [];
  const taken = new Set<string>([GATEWAY_PREFIX]);
  const notFirstParty: string[] = [];
  const firstParty = new Set<string>();
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
    firstParty.add(manifest.name);
    if (options.firstParty === false) continue;
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
      firstParty.has(name) ||
      members.some((member) => member.capability === name)
    )
      continue;
    const stateDir = path.join(options.stateRoot, path.basename(file, ".json"));
    try {
      const launch = planMcpLaunch(installed, {
        stateDir,
        env: options.env,
        secret: (secret) => options.secrets?.get(name, secret),
        packagesRoot: options.packagesRoot,
      });
      const sensitive = sensitivityOf(installed);
      const base = {
        capability: name,
        prefix: namespaceFor(name, taken),
        ...(sensitive ? { sensitive } : {}),
      };
      if (launch.transport === "remote") {
        members.push({
          ...base,
          transport: "remote",
          type: launch.type,
          url: launch.url,
          ...(Object.keys(launch.headers).length
            ? { headers: launch.headers }
            : {}),
        });
        continue;
      }
      await mkdir(stateDir, { recursive: true });
      members.push({
        ...base,
        command: launch.command,
        args: launch.args,
        cwd: launch.cwd,
        env: launch.env,
        inheritEnv: false,
        ...(launch.pin ? { pin: launch.pin } : {}),
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
        uninstalled: true,
      });
  return { members, skipped };
}

// Every text a model reads for a tool, resource or prompt: each named field, and each key and
// string nested inside it (a tool's schema property names, titles, enums and defaults included).
function modelTexts(
  fields: Record<string, unknown>,
): { at: string; text: string }[] {
  const texts: { at: string; text: string }[] = [];
  const walk = (value: unknown, at: string): void => {
    if (typeof value === "string") texts.push({ at, text: value });
    else if (Array.isArray(value))
      value.forEach((item, index) => {
        walk(item, `${at}[${index}]`);
      });
    else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        texts.push({ at: `${at} key`, text: key });
        walk(item, `${at}.${key}`);
      }
  };
  for (const [at, value] of Object.entries(fields)) walk(value, at);
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
type Route = { client: GatewayClient; tool: string };
type PromptRoute = { client: GatewayClient; prompt: string };
type Listing = GatewayListing;
type Loaded = {
  member: GatewayMember;
  client: GatewayClient;
  listing: Listing;
};

// A member listed from its cached manifest: its process starts on the first call that needs
// it, so a session that never uses it never pays for it (T-338 P4). A start that fails is tried
// again on the next call.
class LazyClient implements GatewayClient {
  #inner: GatewayClient | undefined;
  #ready: Promise<GatewayClient> | undefined;

  constructor(
    private readonly make: () => GatewayClient,
    private readonly timeoutMs: number,
    private readonly name: string,
    private readonly onReady: () => Promise<void>,
  ) {}

  #ensure(): Promise<GatewayClient> {
    this.#ready ??= (async () => {
      const inner = this.make();
      this.#inner = inner;
      try {
        await withTimeout(
          inner.connect(),
          this.timeoutMs,
          `${this.name} did not start`,
        );
      } catch (error) {
        inner.close();
        this.#inner = undefined;
        this.#ready = undefined;
        throw error;
      }
      void Promise.resolve().then(this.onReady);
      return inner;
    })();
    return this.#ready;
  }

  async connect(): Promise<void> {
    await this.#ensure();
  }

  async listTools(): Promise<McpTool[]> {
    return (await this.#ensure()).listTools();
  }

  async forwardToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return (await this.#ensure()).forwardToolCall(name, args);
  }

  async listResources(): Promise<McpResource[]> {
    const inner = await this.#ensure();
    return inner.listResources ? inner.listResources() : [];
  }

  async readResource(uri: string): Promise<unknown> {
    const inner = await this.#ensure();
    if (!inner.readResource)
      throw new GatewayError(-32602, `Unknown MCP resource: ${uri}`);
    return inner.readResource(uri);
  }

  async listPrompts(): Promise<McpPrompt[]> {
    const inner = await this.#ensure();
    return inner.listPrompts ? inner.listPrompts() : [];
  }

  async getPrompt(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const inner = await this.#ensure();
    if (!inner.getPrompt)
      throw new GatewayError(-32602, `Unknown MCP prompt: ${name}`);
    return inner.getPrompt(name, args);
  }

  close(): void {
    this.#inner?.close();
  }
}

type Message = Record<string, unknown>;

// One MCP endpoint in front of many servers. Tools are exposed as `<prefix>__<tool>`; a tool
// whose texts carry injected instructions is hidden, since clients read them as prompt. The
// gateway adds no authority and removes none: a call reaches its server with the arguments the
// client sent, so the server's own checks (an approval fingerprint, say) decide as they would
// on a direct connection, and the client's permission prompt stays the human gate.
//
// With `profiles` (T-338 P4) only the members the active profile names are listed, plus one
// tool of the gateway's own, `gateway__use_profile`, that switches profile and tells the
// client its tool list changed.
export class McpGateway {
  readonly #routes = new Map<string, Route>();
  readonly #tools: McpTool[] = [];
  // Resource URIs are exposed unchanged (a server's own texts point at them), so a URI two
  // members both list stays with the first. Prompts are namespaced like tools.
  readonly #resourceRoutes = new Map<string, GatewayClient>();
  readonly #resources: McpResource[] = [];
  readonly #promptRoutes = new Map<string, PromptRoute>();
  readonly #prompts: McpPrompt[] = [];
  readonly #clients: GatewayClient[] = [];
  // Every member whose listing is known (started, or read from its manifest), shown or not.
  readonly #loaded = new Map<string, Loaded>();
  #started: Promise<void> | undefined;
  // Who is on the other end, from `initialize`; fixed once members start.
  #client: string | undefined;
  #profile: GatewayProfile | undefined;
  // Sends a message to the client: notifications, and the gateway's own requests (`roots/list`).
  #send: ((message: Message) => void) | undefined;
  #initialized = false;
  #clientHasRoots = false;
  #roots: Promise<McpRoot[]> | undefined;
  #nextRequest = 1;
  readonly #waiting = new Map<string, (message: Message) => void>();

  constructor(
    private readonly members: GatewayMember[],
    private readonly options: {
      client: (
        member: GatewayMember,
        context: GatewayClientContext,
      ) => GatewayClient;
      version?: string;
      timeoutMs?: number;
      log?: (line: string) => void;
      serverName?: string;
      instructions?: string;
      // The member whose policy `instructions` is: they are sent only when this client can see
      // it, since the text claims that server's tools are callable. Unset: always sent.
      instructionsMember?: string;
      access?: GatewayAccess;
      // The client this gateway serves, as Ocean wrote it into the client's entry
      // (`--client <id>`); then `clientInfo.name` from `initialize` is only logged.
      clientId?: string;
      // The active profile and every installed one. Unset: every member the access rules allow.
      profiles?: { active: GatewayProfile; available: GatewayProfile[] };
      // Members no profile hides: Ocean's own server, whose memory contract holds in every one.
      ungated?: string[];
      // Cached listings; a member found here starts on its first call instead of at once.
      manifests?: GatewayManifestStore;
      // Roots for members when the client has none of its own (the gateway's project folder).
      roots?: McpRoot[];
    },
  ) {
    this.#client = options.clientId;
    this.#profile = options.profiles?.active;
  }

  // How the gateway reaches its client; `serveMcpGateway` attaches stdout.
  attach(send: (message: Message) => void): void {
    this.#send = send;
  }

  get profile(): string | undefined {
    return this.#profile?.name;
  }

  #accessible(member: GatewayMember): boolean {
    return canSee(this.options.access ?? { clients: {} }, this.#client, member);
  }

  #ungated(member: GatewayMember): boolean {
    return Boolean(this.options.ungated?.includes(member.capability));
  }

  #inProfile(member: GatewayMember): boolean {
    return (
      !this.#profile ||
      this.#ungated(member) ||
      profileAllows(this.#profile, member)
    );
  }

  #visible(member: GatewayMember): boolean {
    return this.#accessible(member) && this.#inProfile(member);
  }

  // Loads every member this client may see in its profile; one that fails or hangs is left
  // out, never the whole gateway.
  start(): Promise<void> {
    this.#started ??= this.#begin();
    return this.#started;
  }

  async #begin(): Promise<void> {
    const accessible = this.members.filter((member) => {
      if (this.#accessible(member)) return true;
      this.#log(
        `${member.capability} hidden from ${this.#client ?? "an unnamed client"}${member.sensitive ? ` (${member.sensitive}; allow it in gateway-access.json)` : " (denied in gateway-access.json)"}`,
      );
      return false;
    });
    if (this.#profile) {
      const left = accessible.filter((member) => !this.#inProfile(member));
      this.#log(
        `profile ${this.#profile.name}${left.length ? `: leaves out ${left.map((member) => member.capability).join(", ")}` : ""}`,
      );
    }
    await this.#load(accessible.filter((member) => this.#inProfile(member)));
    this.#rebuild();
  }

  #clientFor(member: GatewayMember): GatewayClient {
    return this.options.client(member, { roots: () => this.#currentRoots() });
  }

  // Only members about to be shown are loaded: a hidden server never runs and its tools never
  // reach the client's context. One with a cached manifest is listed from it and started on its
  // first call; one without is started now and its manifest saved.
  async #load(members: GatewayMember[]): Promise<void> {
    const timeoutMs = this.options.timeoutMs ?? 15_000;
    const fresh: GatewayMember[] = [];
    for (const member of members) {
      if (this.#loaded.has(member.capability)) continue;
      const cached = await this.options.manifests
        ?.read(member)
        .catch(() => undefined);
      if (!cached) {
        fresh.push(member);
        continue;
      }
      const client = new LazyClient(
        () => this.#clientFor(member),
        timeoutMs,
        member.capability,
        () => this.#refresh(member),
      );
      this.#clients.push(client);
      this.#loaded.set(member.capability, { member, client, listing: cached });
    }
    const clients = fresh.map((member) => this.#clientFor(member));
    this.#clients.push(...clients);
    const results = await Promise.allSettled(
      fresh.map(async (member, index) => {
        await withTimeout(
          clients[index].connect(),
          timeoutMs,
          `${member.capability} did not start`,
        );
        return this.#list(member, clients[index], timeoutMs);
      }),
    );
    await Promise.all(
      results.map(async (result, index) => {
        const member = fresh[index];
        if (result.status === "rejected") {
          this.#log(
            `${member.capability} left out: ${errorMessage(result.reason)}`,
          );
          clients[index].close();
          return;
        }
        this.#loaded.set(member.capability, {
          member,
          client: clients[index],
          listing: result.value,
        });
        await this.options.manifests
          ?.write(member, result.value)
          .catch((error) =>
            this.#log(
              `${member.capability} manifest not saved: ${errorMessage(error)}`,
            ),
          );
      }),
    );
  }

  // A started member's tools, resources and prompts. One that cannot list resources or
  // prompts keeps its tools.
  async #list(
    member: GatewayMember,
    client: GatewayClient,
    timeoutMs: number,
  ): Promise<Listing> {
    const tools = await withTimeout(
      client.listTools(),
      timeoutMs,
      `${member.capability} did not list its tools`,
    );
    const optional = async <T>(
      what: string,
      list: (() => Promise<T[]>) | undefined,
    ): Promise<T[]> => {
      if (!list) return [];
      try {
        return await withTimeout(
          list(),
          timeoutMs,
          `${member.capability} did not list its ${what}`,
        );
      } catch (error) {
        this.#log(
          `${member.capability} ${what} left out: ${errorMessage(error)}`,
        );
        return [];
      }
    };
    return {
      tools,
      resources: await optional(
        "resources",
        client.listResources?.bind(client),
      ),
      prompts: await optional("prompts", client.listPrompts?.bind(client)),
    };
  }

  // Once a member listed from its manifest has started, its live listing replaces a stale one
  // and the client is told the list changed.
  async #refresh(member: GatewayMember): Promise<void> {
    const loaded = this.#loaded.get(member.capability);
    if (!loaded) return;
    try {
      const listing = await this.#list(
        member,
        loaded.client,
        this.options.timeoutMs ?? 15_000,
      );
      if (JSON.stringify(listing) === JSON.stringify(loaded.listing)) return;
      loaded.listing = listing;
      this.#log(`${member.capability} lists other tools now; manifest updated`);
      await this.options.manifests?.write(member, listing);
      this.#rebuild();
      this.#announce();
    } catch (error) {
      this.#log(
        `${member.capability} manifest not refreshed: ${errorMessage(error)}`,
      );
    }
  }

  // The routes and lists the client sees, from every loaded member it may see now.
  #rebuild(): void {
    this.#routes.clear();
    this.#tools.length = 0;
    this.#resourceRoutes.clear();
    this.#resources.length = 0;
    this.#promptRoutes.clear();
    this.#prompts.length = 0;
    for (const member of this.members) {
      const loaded = this.#loaded.get(member.capability);
      if (!loaded || !this.#visible(member)) continue;
      for (const tool of loaded.listing.tools)
        this.#expose(member, loaded.client, tool);
      for (const resource of loaded.listing.resources)
        this.#exposeResource(member, loaded.client, resource);
      for (const prompt of loaded.listing.prompts)
        this.#exposePrompt(member, loaded.client, prompt);
    }
    const profileTool = this.#profileTool();
    if (profileTool) this.#tools.push(profileTool);
  }

  // The profiles that would show a member this client may see, with those members' prefixes.
  #profileChoices(): { profile: GatewayProfile; members: string[] }[] {
    const gated = this.members.filter(
      (member) => this.#accessible(member) && !this.#ungated(member),
    );
    return (this.options.profiles?.available ?? [])
      .map((profile) => ({
        profile,
        members: gated
          .filter((member) => profileAllows(profile, member))
          .map((member) => member.prefix),
      }))
      .filter((choice) => choice.members.length);
  }

  // Listed only when some profile would show this client something the gateway holds.
  #profileTool(): McpTool | undefined {
    if (!this.#profile) return undefined;
    const choices = this.#profileChoices();
    if (!choices.length) return undefined;
    const available = this.options.profiles?.available ?? [];
    const names = [
      ...new Set([
        ...choices.map((choice) => choice.profile.name),
        this.#profile.name,
        ...(available.some((profile) => profile.name === "base")
          ? ["base"]
          : []),
      ]),
    ];
    return {
      name: PROFILE_TOOL,
      description: `Switches Ocean's gateway to another profile so its tools are listed. Active: ${this.#profile.name}. Profiles with tools here: ${choices.map((choice) => `${choice.profile.name} (${choice.members.join(", ")})`).join("; ")}. Call it when the start line or ocean_context names one of these profiles, or the task needs one of these tools.`,
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", enum: names } },
        required: ["name"],
        additionalProperties: false,
      },
    };
  }

  async #useProfile(args: Record<string, unknown>): Promise<unknown> {
    const name = typeof args.name === "string" ? args.name : "";
    const available = this.options.profiles?.available ?? [];
    const profile = available.find((candidate) => candidate.name === name);
    if (!profile)
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `No profile named "${name}". Installed: ${available.map((candidate) => candidate.name).join(", ")}.`,
          },
        ],
      };
    this.#profile = profile;
    await this.#load(this.members.filter((member) => this.#visible(member)));
    this.#rebuild();
    this.#announce();
    const shown = this.members
      .filter(
        (member) =>
          this.#loaded.has(member.capability) &&
          this.#visible(member) &&
          !this.#ungated(member),
      )
      .map((member) => member.prefix);
    this.#log(
      `profile ${name} (asked by the client): ${shown.join(", ") || "no gateway members"}`,
    );
    return {
      content: [
        {
          type: "text",
          text: `Profile ${name} is active${shown.length ? `; tools from ${shown.join(", ")} are listed` : "; it adds no gateway tools"}. The client was told its tool list changed. If the new tools do not appear, this client does not reload them: start a new session in a project that uses ${name}.`,
        },
      ],
    };
  }

  // Tells the client the lists changed (MCP `notifications/*/list_changed`).
  #announce(): void {
    if (!this.#initialized || !this.#send) return;
    for (const list of ["tools", "resources", "prompts"])
      this.#send({
        jsonrpc: "2.0",
        method: `notifications/${list}/list_changed`,
      });
  }

  // Sends the client a request of the gateway's own and waits for its answer.
  #ask(method: string, ms: number): Promise<unknown> {
    const send = this.#send;
    if (!send) return Promise.reject(new Error("no client attached"));
    const id = `ocean-gateway-${this.#nextRequest++}`;
    return withTimeout(
      new Promise<unknown>((resolve, reject) => {
        this.#waiting.set(id, (message) => {
          if (isRecord(message.error))
            reject(new Error(String(message.error.message ?? "failed")));
          else resolve(message.result);
        });
        send({ jsonrpc: "2.0", id, method });
      }),
      ms,
      `client did not answer ${method}`,
    ).finally(() => this.#waiting.delete(id));
  }

  // The roots a member is given: the client's own when it has them (MCP `roots/list`), else
  // the folder the gateway was started in. Forwarded so a member's file tools (chrome-devtools'
  // screenshots, say) work outside the OS temp directory.
  #currentRoots(): Promise<McpRoot[]> {
    const fallback = this.options.roots ?? [];
    if (!this.#clientHasRoots || !this.#send) return Promise.resolve(fallback);
    this.#roots ??= this.#ask("roots/list", 5_000)
      .then((result) => {
        const roots =
          isRecord(result) && Array.isArray(result.roots)
            ? result.roots.filter(
                (root): root is McpRoot =>
                  isRecord(root) && typeof root.uri === "string",
              )
            : [];
        return roots.length ? roots : fallback;
      })
      .catch((error) => {
        this.#log(`roots: ${errorMessage(error)}; using the fallback`);
        this.#roots = undefined;
        return fallback;
      });
    return this.#roots;
  }

  // True when a text the model would read carries injected instructions; then it is hidden.
  #injected(
    member: GatewayMember,
    kind: string,
    name: string,
    fields: Record<string, unknown>,
  ): boolean {
    const findings = modelTexts(fields).flatMap(({ at, text }) =>
      scanText(at, text),
    );
    if (!findings.length) return false;
    this.#log(
      `${member.capability} ${kind} ${name} hidden: ${findings.map((finding) => `${finding.rule} in ${finding.source} ("${finding.excerpt}")`).join("; ")}`,
    );
    return true;
  }

  #exposeResource(
    member: GatewayMember,
    client: GatewayClient,
    resource: McpResource,
  ): void {
    if (!isRecord(resource) || typeof resource.uri !== "string") return;
    if (this.#injected(member, "resource", resource.uri, resource)) return;
    if (this.#resourceRoutes.has(resource.uri)) {
      this.#log(
        `${member.capability} lists resource ${resource.uri} already routed; kept the first`,
      );
      return;
    }
    this.#resourceRoutes.set(resource.uri, client);
    this.#resources.push(resource);
  }

  #exposePrompt(
    member: GatewayMember,
    client: GatewayClient,
    prompt: McpPrompt,
  ): void {
    if (!isRecord(prompt) || typeof prompt.name !== "string") return;
    if (this.#injected(member, "prompt", prompt.name, prompt)) return;
    const name = `${member.prefix}__${prompt.name}`;
    if (this.#promptRoutes.has(name)) {
      this.#log(
        `${member.capability} lists prompt ${prompt.name} twice; kept the first`,
      );
      return;
    }
    this.#promptRoutes.set(name, { client, prompt: prompt.name });
    this.#prompts.push({ ...prompt, name });
  }

  #expose(member: GatewayMember, client: GatewayClient, tool: McpTool): void {
    if (
      this.#injected(member, "tool", tool.name, {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })
    )
      return;
    const name = `${member.prefix}__${tool.name}`;
    if (this.#routes.has(name)) {
      this.#log(
        `${member.capability} lists ${tool.name} twice; kept the first`,
      );
      return;
    }
    this.#routes.set(name, { client, tool: tool.name });
    this.#tools.push({ ...tool, name });
  }

  // A tool a visible member serves but does not list (Ocean's ops tools outside ocean-ops,
  // T-338 P5): the call goes to that member, whose own answer decides — never invented here.
  #unlisted(name: string): Route | undefined {
    const split = name.indexOf("__");
    if (split <= 0) return undefined;
    const prefix = name.slice(0, split);
    const member = this.members.find(
      (candidate) => candidate.prefix === prefix && this.#visible(candidate),
    );
    const loaded = member && this.#loaded.get(member.capability);
    const tool = name.slice(split + 2);
    // A tool the member did list but the gateway left out (poisoned, injected) stays out.
    if (!loaded || loaded.listing.tools.some((listed) => listed.name === tool))
      return undefined;
    return { client: loaded.client, tool };
  }

  async tools(): Promise<McpTool[]> {
    await this.start();
    return [...this.#tools];
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.start();
    if (name === PROFILE_TOOL && this.#profile) return this.#useProfile(args);
    const route = this.#routes.get(name) ?? this.#unlisted(name);
    if (!route) throw new GatewayError(-32602, `Unknown MCP tool: ${name}`);
    try {
      return withHint(await route.client.forwardToolCall(route.tool, args));
    } catch (error) {
      const message = errorMessage(error);
      const hint = errorHint(message);
      if (!hint) throw error;
      throw new Error(`${message}\n${hint}`);
    }
  }

  async resources(): Promise<McpResource[]> {
    await this.start();
    return [...this.#resources];
  }

  async readResource(uri: string): Promise<unknown> {
    await this.start();
    const client = this.#resourceRoutes.get(uri);
    if (!client?.readResource)
      throw new GatewayError(-32602, `Unknown MCP resource: ${uri}`);
    return client.readResource(uri);
  }

  async prompts(): Promise<McpPrompt[]> {
    await this.start();
    return [...this.#prompts];
  }

  async getPrompt(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    await this.start();
    const route = this.#promptRoutes.get(name);
    if (!route?.client.getPrompt)
      throw new GatewayError(-32602, `Unknown MCP prompt: ${name}`);
    return route.client.getPrompt(route.prompt, args);
  }

  async handle(request: unknown): Promise<Response | null> {
    // MCP 2025-06-18 has no batches; anything but one request object is invalid.
    if (!isRecord(request))
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      };
    // The client's answer to a request of the gateway's own.
    if (
      request.method === undefined &&
      typeof request.id === "string" &&
      ("result" in request || "error" in request)
    ) {
      this.#waiting.get(request.id)?.(request);
      return null;
    }
    // Notifications get no answer.
    if (request.id === undefined) {
      if (request.method === "notifications/initialized")
        this.#initialized = true;
      if (request.method === "notifications/roots/list_changed")
        this.#roots = undefined;
      return null;
    }
    const id =
      typeof request.id === "string" || typeof request.id === "number"
        ? request.id
        : null;
    return this.#respond(request as Request, id);
  }

  async #respond(request: Request, id: Response["id"]): Promise<Response> {
    try {
      return { jsonrpc: "2.0", id, result: await this.#answer(request) };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: error instanceof GatewayError ? error.code : -32000,
          message: errorMessage(error),
        },
      };
    }
  }

  async #answer(request: Request): Promise<unknown> {
    switch (request.method) {
      case "initialize": {
        const params = isRecord(request.params) ? request.params : {};
        const info = params.clientInfo;
        const named = isRecord(info) && typeof info.name === "string";
        this.#clientHasRoots =
          isRecord(params.capabilities) && isRecord(params.capabilities.roots);
        if (this.options.clientId)
          this.#log(
            `client: ${this.options.clientId}${named ? ` (says ${String(info.name)})` : ""}`,
          );
        else if (!this.#started && named) {
          this.#client = String(info.name);
          this.#log(`client: ${this.#client}`);
        }
        // Members start while the client finishes its handshake.
        void this.start();
        // The lists change when the profile switches or a cached listing turns out stale.
        const changes =
          this.options.profiles || this.options.manifests
            ? { listChanged: true }
            : {};
        return {
          protocolVersion: "2025-06-18",
          // Members start after this answer, so resources and prompts are always offered; a
          // gateway whose members have none lists them empty, which MCP allows.
          capabilities: {
            tools: { ...changes },
            resources: { ...changes },
            prompts: { ...changes },
          },
          serverInfo: {
            name: this.options.serverName ?? "ocean-gateway",
            version: this.options.version ?? "0.0.0",
          },
          ...(this.#instructions()
            ? { instructions: this.options.instructions }
            : {}),
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: await this.tools() };
      case "tools/call": {
        const params = isRecord(request.params) ? request.params : {};
        const args = params.arguments ?? {};
        if (typeof params.name !== "string" || !isRecord(args))
          throw new GatewayError(
            -32602,
            "tools/call needs a tool name and an arguments object",
          );
        return this.call(params.name, args);
      }
      case "resources/list":
        return { resources: await this.resources() };
      case "resources/read": {
        const params = isRecord(request.params) ? request.params : {};
        if (typeof params.uri !== "string")
          throw new GatewayError(-32602, "resources/read needs a uri");
        return this.readResource(params.uri);
      }
      case "prompts/list":
        return { prompts: await this.prompts() };
      case "prompts/get": {
        const params = isRecord(request.params) ? request.params : {};
        const args = params.arguments ?? {};
        if (typeof params.name !== "string" || !isRecord(args))
          throw new GatewayError(
            -32602,
            "prompts/get needs a prompt name and an arguments object",
          );
        return this.getPrompt(params.name, args);
      }
      default:
        throw new GatewayError(
          -32601,
          `Unsupported MCP method: ${request.method ?? ""}`,
        );
    }
  }

  // Instructions describe Ocean's own server: sent only when this client sees it, in its
  // access rules and its profile.
  #instructions(): boolean {
    const { instructions, instructionsMember } = this.options;
    if (!instructions) return false;
    if (!instructionsMember) return true;
    return this.members.some(
      (member) =>
        member.capability === instructionsMember && this.#visible(member),
    );
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
  const write = (response: Response | Message | null) => {
    if (response) output.write(`${JSON.stringify(response)}\n`);
  };
  gateway.attach(write);
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
      let request: unknown;
      try {
        request = JSON.parse(line);
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
