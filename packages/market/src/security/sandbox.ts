import os from "node:os";
import path from "node:path";
import { realDeepestExisting } from "@ocean/core/shared/paths.js";
import type { PermissionPolicy } from "./permissions.js";

export type Command = { command: string; args: string[] };
export type SandboxKind = "sandbox-exec" | "none";

// Where a package runner (npx, uvx) must be able to write to work at all: its caches and the
// temp dir. Everything else a capability writes has to be declared.
export function runtimeWritablePaths(home = os.homedir()): string[] {
  return [
    os.tmpdir(),
    path.join(home, ".npm"),
    path.join(home, ".cache"),
    path.join(home, "Library", "Caches"),
    path.join(home, ".local", "share", "uv"),
  ];
}

// Reads stay open for system libraries, but these never are unless declared under fs.read.
export function secretPaths(home: string): string[] {
  return [
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".docker",
    ".netrc",
    ".npmrc",
    ".config/gh",
    ".config/gcloud",
    "Library/Keychains",
  ].map((entry) => path.join(home, entry));
}

const sbplString = (value: string) =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// macOS Seatbelt profile: reads stay open (runtimes need system libraries) except secret
// locations, writes are denied
// outside the declared and runtime paths, and the network is denied unless any host was
// declared. Seatbelt cannot filter by hostname, so a declared host opens outbound network;
// remote endpoints are still checked per host by the launcher.
export function seatbeltProfile(
  policy: PermissionPolicy,
  extraWritable: string[],
): string {
  const writable = [
    ...new Set(
      [...policy.writablePaths(), ...extraWritable].map(realDeepestExisting),
    ),
  ];
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper")${writable
      .map((entry) => ` (subpath ${sbplString(entry)})`)
      .join("")})`,
  ];
  const secrets = secretPaths(policy.home)
    .filter((entry) => !policy.allows({ type: "fs.read", target: entry }))
    .map(realDeepestExisting);
  if (secrets.length)
    lines.push(
      `(deny file-read* file-write*${secrets.map((entry) => ` (subpath ${sbplString(entry)})`).join("")})`,
    );
  if (!policy.permissions.network.length) lines.push("(deny network*)");
  return lines.join("\n");
}

export function sandboxed(
  policy: PermissionPolicy,
  target: Command,
  options: {
    extraWritable: string[];
    platform?: NodeJS.Platform;
    allowUnsandboxed?: boolean;
  },
): Command & { sandbox: SandboxKind } {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin")
    return {
      command: "/usr/bin/sandbox-exec",
      args: [
        "-p",
        seatbeltProfile(policy, options.extraWritable),
        target.command,
        ...target.args,
      ],
      sandbox: "sandbox-exec",
    };
  if (!options.allowUnsandboxed)
    throw new Error(
      `No process sandbox is available on ${platform}; refusing to launch ${policy.capability} unsandboxed`,
    );
  return { ...target, sandbox: "none" };
}
