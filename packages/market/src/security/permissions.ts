import os from "node:os";
import path from "node:path";
import type { CapabilityPermissions } from "@ocean/core/domain/capabilities/capability-manifest.js";

export type PermissionRequest = {
  type: "env" | "exec" | "network" | "fs.read" | "fs.write";
  target: string;
};

export class PermissionDeniedError extends Error {
  constructor(
    readonly capability: string,
    readonly request: PermissionRequest,
  ) {
    super(
      `${capability} did not declare permission ${request.type} "${request.target}"`,
    );
    this.name = "PermissionDeniedError";
  }
}

export function expandHome(value: string, home = os.homedir()): string {
  return path.resolve(
    value === "~"
      ? home
      : value.startsWith("~/")
        ? path.join(home, value.slice(2))
        : value,
  );
}

const within = (root: string, candidate: string) =>
  candidate === root || candidate.startsWith(`${root}${path.sep}`);

// What a capability declared, as the runtime checks it. Anything not declared is refused.
// - env / exec: exact name (exec also matches a command's basename)
// - network: exact host, `*.domain` for subdomains, or `*` for any host
// - fs.read / fs.write: the path or anything below it (`~` expands); write implies read
export class PermissionPolicy {
  constructor(
    readonly capability: string,
    readonly permissions: CapabilityPermissions,
    readonly home = os.homedir(),
  ) {}

  writablePaths(): string[] {
    return this.permissions.filesystem.write.map((entry) =>
      expandHome(entry, this.home),
    );
  }

  allows({ type, target }: PermissionRequest): boolean {
    const { filesystem, network, env, exec } = this.permissions;
    if (type === "env") return env.includes(target);
    if (type === "exec")
      return exec.includes(target) || exec.includes(path.basename(target));
    if (type === "network") {
      const host = target.toLowerCase();
      return network.some(
        (entry) =>
          entry === "*" ||
          entry === host ||
          (entry.startsWith("*.") && host.endsWith(entry.slice(1))),
      );
    }
    const candidate = expandHome(target, this.home);
    const roots =
      type === "fs.write"
        ? filesystem.write
        : [...filesystem.read, ...filesystem.write];
    return roots.some((root) => within(expandHome(root, this.home), candidate));
  }

  require(request: PermissionRequest): void {
    if (!this.allows(request))
      throw new PermissionDeniedError(this.capability, request);
  }
}
