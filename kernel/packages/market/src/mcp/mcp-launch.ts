import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CapabilityPermissions } from "@ocean/core/domain/capabilities/capability-manifest.js";
import {
  type McpServerSpec,
  remoteUrlAllowed,
} from "../adapters/mcp-adapter.js";
import { PermissionPolicy } from "../security/permissions.js";

// What the mcp adapter wrote for one installed server.
export type InstalledMcpServer = {
  capability: string;
  version: string;
  permissions: CapabilityPermissions;
  server: McpServerSpec;
};

export type McpLaunch =
  | {
      transport: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd: string;
      // An npm package that runs through `npx` because no pinned copy is installed yet; the
      // gateway installs one so the next start skips npx (T-338 P4).
      pin?: { identifier: string; version: string };
    }
  | {
      transport: "remote";
      type: RemoteTransport;
      url: string;
      // Resolved header values (tokens, mostly): held in memory, never written or logged.
      headers: Record<string, string>;
    };

export type RemoteTransport = "streamable-http" | "sse";
const remoteTransports: readonly string[] = ["streamable-http", "sse"];

// Where each runner takes its own (runtime) arguments: before the package for npx and uvx,
// after `run` for docker, so container flags such as `-e` or `-v` reach `docker run`.
const runners: Record<
  string,
  (
    identifier: string,
    version: string | undefined,
    runtime: string[],
  ) => { command: string; args: string[] }
> = {
  // Plain `npx -y`, never `--prefer-offline`: with that flag npx answers from a cached package
  // list and refuses a version published after it (ETARGET) for as long as the cache lives, so a
  // capability bump never starts (measured 2026-11-19, T-316).
  npm: (identifier, version, runtime) => ({
    command: "npx",
    args: [...runtime, "-y", version ? `${identifier}@${version}` : identifier],
  }),
  pypi: (identifier, version, runtime) => ({
    command: "uvx",
    args: [...runtime, version ? `${identifier}==${version}` : identifier],
  }),
  oci: (identifier, version, runtime) => ({
    command: "docker",
    args: [
      "run",
      "-i",
      "--rm",
      ...runtime,
      version ? `${identifier}:${version}` : identifier,
    ],
  }),
};

// The command a registry type is started with (`npx`, `uvx`, `docker`), as an `exec` permission
// names it.
export function runnerCommand(registryType: string): string {
  const runner = runners[registryType];
  if (!runner)
    throw new Error(`registry type ${registryType} is not supported`);
  return runner("x", undefined, []).command;
}

type Argument = {
  type?: unknown;
  name?: unknown;
  value?: unknown;
  default?: unknown;
  isRequired?: unknown;
};

// First-party servers: every argument is a literal.
export function literalArguments(list: unknown, where: string): string[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`${where} must be an array`);
  return (list as Argument[]).flatMap((argument) => {
    if (typeof argument?.value !== "string")
      throw new Error(
        `${where}: only arguments with a literal value are supported`,
      );
    if (argument.type === "named") {
      if (typeof argument.name !== "string")
        throw new Error(`${where}: a named argument needs a name`);
      return [argument.name, argument.value];
    }
    return [argument.value];
  });
}

// `{name}` placeholders in a registry value (`Bearer {api_key}`, `TOKEN={token}`).
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g;
const placeholders = (value: string) =>
  [...value.matchAll(PLACEHOLDER)].map((match) => match[1]);

// One value a server needs at launch: an environment variable, a `{placeholder}` in an argument
// or header, or a header that is a secret by itself. Each is a declared `env` permission and is
// taken from the environment, then from the secret store.
export type LaunchInput = {
  name: string;
  kind: "env" | "argument" | "header";
  required: boolean;
  secret: boolean;
  description?: string;
};

type Described = {
  name?: unknown;
  value?: unknown;
  isRequired?: unknown;
  isSecret?: unknown;
  description?: unknown;
  variables?: Record<
    string,
    { isRequired?: unknown; isSecret?: unknown; description?: unknown }
  >;
};

const asList = (value: unknown) =>
  Array.isArray(value) ? (value as Described[]) : [];

// The stdio package a launch uses, or none (then the first remote).
export function stdioPackage(
  server: McpServerSpec,
): Record<string, unknown> | undefined {
  return server.packages?.find((item) => {
    const transport = (item.transport as { type?: unknown } | undefined)?.type;
    return transport === undefined || transport === "stdio";
  });
}

export function launchInputs(server: McpServerSpec): LaunchInput[] {
  const inputs = new Map<string, LaunchInput>();
  const add = (input: LaunchInput) => {
    const have = inputs.get(input.name);
    inputs.set(
      input.name,
      have
        ? {
            ...have,
            required: have.required || input.required,
            secret: have.secret || input.secret,
          }
        : input,
    );
  };
  const fromTemplate = (
    item: Described,
    kind: LaunchInput["kind"],
    value: string,
  ) => {
    for (const name of placeholders(value)) {
      const variable = item.variables?.[name];
      add({
        name,
        kind,
        required: item.isRequired === true || variable?.isRequired === true,
        secret: item.isSecret === true || variable?.isSecret === true,
        description:
          typeof variable?.description === "string"
            ? variable.description
            : typeof item.description === "string"
              ? item.description
              : undefined,
      });
    }
  };
  const stdio = stdioPackage(server);
  if (stdio) {
    for (const variable of asList(stdio.environmentVariables))
      if (typeof variable.name === "string")
        add({
          name: variable.name,
          kind: "env",
          required: variable.isRequired === true,
          secret: variable.isSecret === true,
          description:
            typeof variable.description === "string"
              ? variable.description
              : undefined,
        });
    for (const argument of [
      ...asList(stdio.runtimeArguments),
      ...asList(stdio.packageArguments),
    ])
      if (typeof argument.value === "string")
        fromTemplate(argument, "argument", argument.value);
    return [...inputs.values()];
  }
  const remote = server.remotes?.[0];
  for (const header of asList(remote?.headers)) {
    if (typeof header.name !== "string") continue;
    if (typeof header.value === "string")
      fromTemplate(header, "header", header.value);
    else
      add({
        name: header.name,
        kind: "header",
        required: header.isRequired === true,
        secret: header.isSecret === true,
        description:
          typeof header.description === "string"
            ? header.description
            : undefined,
      });
  }
  return [...inputs.values()];
}

const missing = (capability: string, name: string) =>
  new Error(
    `${capability} needs ${name}: set it in the environment, or run \`ocean market secret set ${capability} ${name}\``,
  );

// Turns an installed server into the exact process (or endpoint) to connect to, checking every
// step against what the capability declared: the runner must be a declared `exec`, every value
// it is given a declared `env`, a remote's host a declared `network`. The process gets only
// those variables (plus PATH so the runner resolves). A value comes from the environment, then
// from `secret` (the secret store); an optional one that is missing is left out.
export function planMcpLaunch(
  installed: InstalledMcpServer,
  options: {
    stateDir: string;
    env?: NodeJS.ProcessEnv;
    home?: string;
    execPath?: string;
    secret?: (name: string) => string | undefined;
    // Where pinned npm packages live (`<root>/<id>@<version>`); unset: always npx.
    packagesRoot?: string;
  },
): McpLaunch {
  const home = options.home ?? os.homedir();
  const hostEnv = options.env ?? process.env;
  const policy = new PermissionPolicy(
    installed.capability,
    installed.permissions,
    home,
  );
  const { server, capability } = installed;
  const value = (name: string) => {
    policy.require({ type: "env", target: name });
    return hostEnv[name] ?? options.secret?.(name);
  };
  // A template with every placeholder filled, or undefined when one has no value.
  const fill = (template: string) => {
    let complete = true;
    const filled = template.replace(PLACEHOLDER, (_, name: string) => {
      const found = value(name);
      if (found === undefined) complete = false;
      return found ?? "";
    });
    return complete ? filled : undefined;
  };
  const resolveArguments = (list: unknown, where: string): string[] => {
    if (list === undefined) return [];
    if (!Array.isArray(list)) throw new Error(`${where} must be an array`);
    return (list as Argument[]).flatMap((argument) => {
      const raw = argument?.value ?? argument?.default;
      if (typeof raw !== "string")
        throw new Error(
          `${capability} ${where}: an argument needs a value or a default`,
        );
      const filled = fill(raw);
      if (filled === undefined) {
        if (argument.isRequired === true)
          throw missing(capability, placeholders(raw)[0]);
        return [];
      }
      if (argument.type === "named") {
        if (typeof argument.name !== "string")
          throw new Error(`${where}: a named argument needs a name`);
        return [argument.name, filled];
      }
      return [filled];
    });
  };

  const stdio = stdioPackage(server);
  if (!stdio) {
    const remote = server.remotes?.[0];
    if (!remote)
      throw new Error(`${capability} has no stdio package or remote endpoint`);
    // Checked again here, not only at install: the installed file is plain JSON on disk.
    const url = new URL(String(remote.url));
    if (!remoteUrlAllowed(url))
      throw new Error(
        `${capability}: remote ${url.href} must be https (or http on loopback)`,
      );
    const type = String(remote.type ?? "streamable-http");
    if (!remoteTransports.includes(type))
      throw new Error(
        `${capability}: remote transport ${type} is not supported`,
      );
    policy.require({ type: "network", target: url.hostname });
    const headers: Record<string, string> = {};
    for (const header of asList(remote.headers)) {
      if (typeof header.name !== "string") continue;
      const filled =
        typeof header.value === "string"
          ? fill(header.value)
          : value(header.name);
      if (filled !== undefined) headers[header.name] = filled;
      else if (header.isRequired === true)
        throw missing(
          capability,
          typeof header.value === "string"
            ? placeholders(header.value)[0]
            : header.name,
        );
    }
    return {
      transport: "remote",
      type: type as RemoteTransport,
      url: url.href,
      headers,
    };
  }

  const registryType = String(stdio.registryType);
  const runner = runners[registryType];
  if (!runner)
    throw new Error(
      `${capability}: registry type ${registryType} is not supported`,
    );
  const base = runner(
    String(stdio.identifier),
    typeof stdio.version === "string" ? stdio.version : undefined,
    resolveArguments(stdio.runtimeArguments, "runtimeArguments"),
  );
  policy.require({ type: "exec", target: base.command });

  // The node running Ocean comes first, so its npx resolves even when a GUI client (Claude
  // Desktop, VS Code) starts this with the login PATH, which lacks a version-managed node.
  const env: Record<string, string> = {
    PATH: [
      path.dirname(options.execPath ?? process.execPath),
      hostEnv.PATH ?? "/usr/bin:/bin",
    ].join(path.delimiter),
    HOME: home,
  };
  for (const variable of asList(stdio.environmentVariables) as (Described & {
    default?: unknown;
  })[]) {
    if (typeof variable?.name !== "string")
      throw new Error(`${capability}: environment variable without a name`);
    const found =
      value(variable.name) ??
      (typeof variable.default === "string" ? variable.default : undefined);
    if (found !== undefined) env[variable.name] = found;
    else if (variable.isRequired === true)
      throw missing(capability, variable.name);
  }

  const packageArgs = resolveArguments(
    stdio.packageArguments,
    "packageArguments",
  );
  // An exact npm version with no runtime arguments can run from a pinned copy: node starts the
  // package's bin directly, with no npx resolving and no registry round trip on each start.
  const identifier = String(stdio.identifier);
  const version = typeof stdio.version === "string" ? stdio.version : "";
  const pinnable =
    registryType === "npm" &&
    EXACT_VERSION.test(version) &&
    !asList(stdio.runtimeArguments).length;
  if (pinnable && options.packagesRoot) {
    const bin = pinnedBin(options.packagesRoot, identifier, version);
    if (bin)
      return {
        transport: "stdio",
        command: options.execPath ?? process.execPath,
        args: [bin, ...packageArgs],
        env,
        cwd: options.stateDir,
      };
  }
  return {
    transport: "stdio",
    command: base.command,
    args: [...base.args, ...packageArgs],
    env,
    cwd: options.stateDir,
    ...(pinnable && options.packagesRoot
      ? { pin: { identifier, version } }
      : {}),
  };
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const pinnedDir = (root: string, identifier: string, version: string) =>
  path.join(root, `${identifier.replace(/[\\/]/g, "__")}@${version}`);

// The pinned copy's bin script, or undefined when it is not installed (or names no bin).
export function pinnedBin(
  root: string,
  identifier: string,
  version: string,
): string | undefined {
  const packageDir = path.join(
    pinnedDir(root, identifier, version),
    "node_modules",
    ...identifier.split("/"),
  );
  const manifest = path.join(packageDir, "package.json");
  if (!existsSync(manifest)) return undefined;
  try {
    const json = JSON.parse(readFileSync(manifest, "utf8")) as {
      version?: unknown;
      bin?: unknown;
    };
    if (json.version !== version) return undefined;
    const unscoped = identifier.split("/").pop() ?? identifier;
    const bin =
      typeof json.bin === "string"
        ? json.bin
        : json.bin && typeof json.bin === "object"
          ? ((json.bin as Record<string, unknown>)[unscoped] ??
            (Object.values(json.bin).length === 1
              ? Object.values(json.bin)[0]
              : undefined))
          : undefined;
    if (typeof bin !== "string") return undefined;
    const file = path.join(packageDir, bin);
    return existsSync(file) ? file : undefined;
  } catch {
    return undefined;
  }
}

// Installs one exact npm version under `root` with the npm beside the running node. Built in a
// temporary folder and renamed into place, so a start that races it sees all of it or none.
export async function pinNpmPackage(
  root: string,
  identifier: string,
  version: string,
  options: { execPath?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const target = pinnedDir(root, identifier, version);
  const existing = pinnedBin(root, identifier, version);
  if (existing) return existing;
  await mkdir(root, { recursive: true });
  const temp = await mkdtemp(path.join(root, ".pin-"));
  const nodeDir = path.dirname(options.execPath ?? process.execPath);
  const windows = process.platform === "win32";
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        windows ? "npm.cmd" : "npm",
        [
          "install",
          "--prefix",
          temp,
          "--no-save",
          "--no-audit",
          "--no-fund",
          // Install scripts stay off, as an extra layer: the servers pinned so far need none.
          "--ignore-scripts",
          `${identifier}@${version}`,
        ],
        {
          env: {
            ...(options.env ?? process.env),
            PATH: [nodeDir, (options.env ?? process.env).PATH ?? ""].join(
              path.delimiter,
            ),
          },
          shell: windows,
          timeout: 300_000,
        },
        (error) => (error ? reject(error) : resolve()),
      );
    });
    await rename(temp, target).catch(async (error: NodeJS.ErrnoException) => {
      // Another gateway pinned it first.
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  const bin = pinnedBin(root, identifier, version);
  if (!bin)
    throw new Error(`${identifier}@${version} installed but names no bin`);
  return bin;
}
