import {
  type CapabilityManifest,
  capabilityManifestSchema,
  semverPattern,
} from "@ocean/core/domain/capabilities/capability-manifest.js";
import type { CapabilityAdapter } from "./adapter.js";

export type ResolvedCapability = {
  manifest: CapabilityManifest;
  adapter: CapabilityAdapter;
  spec: unknown;
};

export class CapabilityRegistry {
  readonly #adapters = new Map<string, CapabilityAdapter>();

  register(adapter: CapabilityAdapter): void {
    if (this.#adapters.has(adapter.kind))
      throw new Error(
        `A capability adapter for kind "${adapter.kind}" is already registered`,
      );
    this.#adapters.set(adapter.kind, adapter);
  }

  kinds(): string[] {
    return [...this.#adapters.keys()].sort();
  }

  adapterFor(kind: string): CapabilityAdapter {
    const adapter = this.#adapters.get(kind);
    if (!adapter)
      throw new Error(
        `No capability adapter for kind "${kind}" (registered: ${this.kinds().join(", ") || "none"})`,
      );
    return adapter;
  }

  // Validates the envelope, then the kind-specific spec through its adapter.
  resolve(raw: unknown): ResolvedCapability {
    const parsed = capabilityManifestSchema.safeParse(raw);
    if (!parsed.success)
      throw new Error(
        `Invalid capability manifest: ${parsed.error.issues.map(describeIssue).join("; ")}`,
      );
    const manifest = parsed.data;
    const adapter = this.adapterFor(manifest.kind);
    let spec: unknown;
    try {
      spec = adapter.parseSpec(manifest.spec);
    } catch (error) {
      throw new Error(
        `Invalid ${manifest.kind} spec for ${manifest.name}@${manifest.version}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { manifest, adapter, spec };
  }
}

function describeIssue(issue: {
  path: PropertyKey[];
  message: string;
}): string {
  return issue.path.length
    ? `${issue.path.map(String).join(".")}: ${issue.message}`
    : issue.message;
}

// Semver precedence (semver.org §11), enough to pick the newest version of a capability.
export function compareSemver(a: string, b: string): number {
  const parse = (value: string) => {
    const match = semverPattern.exec(value);
    if (!match) throw new Error(`Not a semver version: ${value}`);
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4]?.split(".") ?? [],
    };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index++) {
    const delta = left.core[index] - right.core[index];
    if (delta !== 0) return Math.sign(delta);
  }
  if (!left.pre.length || !right.pre.length)
    return Math.sign(right.pre.length - left.pre.length);
  for (
    let index = 0;
    index < Math.max(left.pre.length, right.pre.length);
    index++
  ) {
    const x = left.pre[index];
    const y = right.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const delta = Number(x) - Number(y);
      if (delta !== 0) return Math.sign(delta);
    } else if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
