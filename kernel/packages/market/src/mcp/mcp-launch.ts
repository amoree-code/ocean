import os from "node:os";
import path from "node:path";
import type { CapabilityPermissions } from "@ocean/core/domain/capabilities/capability-manifest.js";
import type { McpServerSpec } from "../adapters/mcp-adapter.js";
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
    }
  | { transport: "remote"; type: string; url: string };

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

type Argument = { type?: unknown; name?: unknown; value?: unknown };

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

// Turns an installed server into the exact process (or endpoint) to connect to, checking every
// step against what the capability declared: the runner must be a declared `exec`, every
// environment variable a declared `env`, a remote's host a declared `network`. The process gets
// only those variables (plus PATH so the runner resolves).
export function planMcpLaunch(
  installed: InstalledMcpServer,
  options: {
    stateDir: string;
    env?: NodeJS.ProcessEnv;
    home?: string;
    execPath?: string;
  },
): McpLaunch {
  const home = options.home ?? os.homedir();
  const hostEnv = options.env ?? process.env;
  const policy = new PermissionPolicy(
    installed.capability,
    installed.permissions,
    home,
  );
  const { server } = installed;

  const stdio = server.packages?.find((item) => {
    const transport = (item.transport as { type?: unknown } | undefined)?.type;
    return transport === undefined || transport === "stdio";
  });
  if (!stdio) {
    const remote = server.remotes?.[0];
    if (!remote)
      throw new Error(
        `${installed.capability} has no stdio package or remote endpoint`,
      );
    const url = new URL(String(remote.url));
    policy.require({ type: "network", target: url.hostname });
    return {
      transport: "remote",
      type: String(remote.type ?? "streamable-http"),
      url: url.href,
    };
  }

  const registryType = String(stdio.registryType);
  const runner = runners[registryType];
  if (!runner)
    throw new Error(
      `${installed.capability}: registry type ${registryType} is not supported`,
    );
  const base = runner(
    String(stdio.identifier),
    typeof stdio.version === "string" ? stdio.version : undefined,
    literalArguments(stdio.runtimeArguments, "runtimeArguments"),
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
  const declaredVariables = Array.isArray(stdio.environmentVariables)
    ? stdio.environmentVariables
    : [];
  for (const variable of declaredVariables as {
    name?: unknown;
    isRequired?: unknown;
    default?: unknown;
  }[]) {
    if (typeof variable?.name !== "string")
      throw new Error(
        `${installed.capability}: environment variable without a name`,
      );
    policy.require({ type: "env", target: variable.name });
    const value =
      hostEnv[variable.name] ??
      (typeof variable.default === "string" ? variable.default : undefined);
    if (value !== undefined) env[variable.name] = value;
    else if (variable.isRequired === true)
      throw new Error(
        `${installed.capability} needs ${variable.name} set in the environment`,
      );
  }

  const args = [
    ...base.args,
    ...literalArguments(stdio.packageArguments, "packageArguments"),
  ];
  return {
    transport: "stdio",
    command: base.command,
    args,
    env,
    cwd: options.stateDir,
  };
}
