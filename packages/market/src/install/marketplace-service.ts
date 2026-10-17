import { randomUUID } from "node:crypto";
import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { CapabilityManifest } from "@ocean/core/domain/capabilities/capability-manifest.js";
import { resolveWithin } from "@ocean/core/shared/paths.js";
import type { CapabilityCatalog, CatalogEntry } from "../capability/catalog.js";
import { contentDigest } from "../capability/content-digest.js";
import type { CapabilityRegistry } from "../capability/registry.js";
import { type LockEntry, readLock, writeLock } from "./lock.js";

// Asked before anything is installed that declares permissions. Returning false refuses.
export type ConsentPrompt = (manifest: CapabilityManifest) => Promise<boolean>;

export type MarketplaceOptions = {
  registry: CapabilityRegistry;
  catalog: CapabilityCatalog;
  // Content-addressed payloads live at `<storeDir>/<sha256>`.
  storeDir: string;
  lockFile: string;
  consent: ConsentPrompt;
};

export type InstallResult = {
  name: string;
  version: string;
  status: "installed" | "updated" | "unchanged";
  previous?: string;
};

export function hasPermissions(manifest: CapabilityManifest): boolean {
  const { filesystem, network, env, exec } = manifest.permissions;
  return [filesystem.read, filesystem.write, network, env, exec].some(
    (list) => list.length > 0,
  );
}

// resolve → fetch → verify → consent → install → lock. Kind-agnostic: every kind-specific step
// goes through the adapter the registry returns.
export class MarketplaceService {
  readonly #options: MarketplaceOptions;

  constructor(options: MarketplaceOptions) {
    this.#options = options;
  }

  async installed(): Promise<Record<string, LockEntry>> {
    return (await readLock(this.#options.lockFile)).installed;
  }

  async install(name: string, version?: string): Promise<InstallResult> {
    const entry = await this.#options.catalog.find(name, version);
    if (!entry)
      throw new Error(
        `${name}${version ? `@${version}` : ""} is not in any marketplace index`,
      );
    const { registry, lockFile, consent } = this.#options;
    const { manifest, adapter, spec } = registry.resolve(entry.manifest);
    if (manifest.provenance)
      throw new Error(
        `${manifest.name}@${manifest.version} carries sigstore provenance, which this Ocean cannot verify yet; refusing rather than ignoring it`,
      );

    const lock = await readLock(lockFile);
    const current = lock.installed[manifest.name];
    if (
      current &&
      current.manifest.version === manifest.version &&
      current.manifest.integrity.sha256 === manifest.integrity.sha256
    )
      return {
        name: manifest.name,
        version: manifest.version,
        status: "unchanged",
      };

    const contentDir = await this.#fetchVerified(entry);
    if (hasPermissions(manifest) && !(await consent(manifest)))
      throw new Error(
        `Install of ${manifest.name}@${manifest.version} refused: permissions not approved`,
      );

    const previous = current ? registry.resolve(current.manifest) : undefined;
    if (previous)
      await previous.adapter.uninstall({
        manifest: previous.manifest,
        spec: previous.spec,
      });
    try {
      await adapter.install({ manifest, spec, contentDir });
    } catch (error) {
      // Put the previous version back from its content address so a failed update is not an
      // uninstall; the lock still names it. If that fails too, the lock must stop claiming it.
      if (previous)
        try {
          await previous.adapter.install({
            manifest: previous.manifest,
            spec: previous.spec,
            contentDir: await this.#storedPayload(previous.manifest),
          });
        } catch (restoreError) {
          delete lock.installed[manifest.name];
          await writeLock(lockFile, lock);
          throw new Error(
            `${message(error)}; restoring ${previous.manifest.version} also failed (${message(restoreError)}), so ${manifest.name} is no longer installed`,
          );
        }
      throw error;
    }
    lock.installed[manifest.name] = {
      manifest: entry.manifest,
      sourceId: entry.sourceId,
      installedAt: new Date().toISOString(),
    };
    await writeLock(lockFile, lock);
    return current
      ? {
          name: manifest.name,
          version: manifest.version,
          status: "updated",
          previous: current.manifest.version,
        }
      : { name: manifest.name, version: manifest.version, status: "installed" };
  }

  // The newest version any index offers; `unchanged` when that is what is installed.
  async update(name: string): Promise<InstallResult> {
    if (!(await this.installed())[name])
      throw new Error(`${name} is not installed`);
    return this.install(name);
  }

  async uninstall(name: string): Promise<void> {
    const { registry, lockFile } = this.#options;
    const lock = await readLock(lockFile);
    const current = lock.installed[name];
    if (!current) throw new Error(`${name} is not installed`);
    const { manifest, adapter, spec } = registry.resolve(current.manifest);
    await adapter.uninstall({ manifest, spec });
    delete lock.installed[name];
    await writeLock(lockFile, lock);
  }

  // A previously verified payload, re-verified: the store is plain files and may have been touched.
  async #storedPayload(manifest: CapabilityManifest): Promise<string> {
    const stored = path.join(this.#options.storeDir, manifest.integrity.sha256);
    if ((await contentDigest(stored)) !== manifest.integrity.sha256)
      throw new Error(
        `stored payload for ${manifest.name}@${manifest.version} no longer matches its digest`,
      );
    return stored;
  }

  // Copies the payload into a private staging directory, hashes that copy (not the source, which
  // could change after the check), and only then moves it to its content address.
  async #fetchVerified(entry: CatalogEntry): Promise<string> {
    const { manifest } = entry;
    if (manifest.source.type !== "path")
      throw new Error(
        `${manifest.name}: ${manifest.source.type} sources are not supported yet (offline indexes only)`,
      );
    const source = resolveWithin(entry.baseDir, manifest.source.path);
    const expected = manifest.integrity.sha256;
    const target = path.join(this.#options.storeDir, expected);
    if (await exists(target)) {
      if ((await contentDigest(target)) === expected) return target;
      await rm(target, { recursive: true, force: true });
    }
    await mkdir(this.#options.storeDir, { recursive: true });
    const staging = path.join(
      this.#options.storeDir,
      `.staging-${randomUUID()}`,
    );
    try {
      await cp(source, staging, {
        recursive: true,
        verbatimSymlinks: true,
        errorOnExist: true,
      });
      const actual = await contentDigest(staging);
      if (actual !== expected)
        throw new Error(
          `Integrity check failed for ${manifest.name}@${manifest.version}: expected sha256 ${expected}, got ${actual}`,
        );
      await rename(staging, target);
      return target;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
