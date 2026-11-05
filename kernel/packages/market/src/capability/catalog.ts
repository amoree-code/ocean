import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type CapabilityManifest,
  marketplaceIndexSchema,
} from "@ocean/core/domain/capabilities/capability-manifest.js";
import { compareSemver } from "./registry.js";

// One manifest as a source offered it. `baseDir` anchors a manifest's relative `source.path`.
export type CatalogEntry = {
  manifest: CapabilityManifest;
  sourceId: string;
  baseDir: string;
};

// Anything that can list manifests: a local `ocean-marketplace.json`, a cached remote index, or a
// federated registry. The catalog merges them without knowing which is which.
export interface CatalogSource {
  readonly id: string;
  list(): Promise<CatalogEntry[]>;
}

export class LocalIndexSource implements CatalogSource {
  readonly id: string;
  readonly #indexFile: string;

  constructor(indexFile: string) {
    this.#indexFile = path.resolve(indexFile);
    this.id = `file:${this.#indexFile}`;
  }

  async list(): Promise<CatalogEntry[]> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.#indexFile, "utf8"));
    } catch (error) {
      throw new Error(
        `Cannot read marketplace index ${this.#indexFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const parsed = marketplaceIndexSchema.safeParse(raw);
    if (!parsed.success)
      throw new Error(
        `Invalid marketplace index ${this.#indexFile}: ${parsed.error.issues
          .map(
            (issue) => `${issue.path.map(String).join(".")}: ${issue.message}`,
          )
          .join("; ")}`,
      );
    const baseDir = path.dirname(this.#indexFile);
    return parsed.data.capabilities.map((manifest) => ({
      manifest,
      sourceId: this.id,
      baseDir,
    }));
  }
}

export class CapabilityCatalog {
  readonly #sources: CatalogSource[];

  constructor(sources: CatalogSource[]) {
    this.#sources = sources;
  }

  // Earlier sources win when two offer the same name@version.
  async list(): Promise<CatalogEntry[]> {
    const seen = new Set<string>();
    const entries: CatalogEntry[] = [];
    for (const source of this.#sources)
      for (const entry of await source.list()) {
        const key = `${entry.manifest.name}@${entry.manifest.version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(entry);
      }
    return entries;
  }

  // An exact version when given, otherwise the newest non-prerelease (a prerelease only when
  // nothing else exists).
  async find(
    name: string,
    version?: string,
  ): Promise<CatalogEntry | undefined> {
    const candidates = (await this.list()).filter(
      (entry) => entry.manifest.name === name,
    );
    if (version)
      return candidates.find((entry) => entry.manifest.version === version);
    const stable = candidates.filter(
      (entry) => !entry.manifest.version.split("+")[0].includes("-"),
    );
    const pool = stable.length ? stable : candidates;
    return pool.sort((a, b) =>
      compareSemver(b.manifest.version, a.manifest.version),
    )[0];
  }
}
