import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CapabilityManifest } from "@ocean/core/domain/capabilities/capability-manifest.js";

// `bridge/installed/ocean.lock`: what is installed, from which manifest, pinned by digest. It is
// machine-local state and never leaves `bridge/`.
export type LockEntry = {
  manifest: CapabilityManifest;
  sourceId: string;
  installedAt: string;
};
export type LockFile = { lockVersion: 1; installed: Record<string, LockEntry> };

export async function readLock(file: string): Promise<LockFile> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { lockVersion: 1, installed: {} };
    throw error;
  }
  const parsed = JSON.parse(raw) as LockFile;
  if (
    parsed?.lockVersion !== 1 ||
    typeof parsed.installed !== "object" ||
    !parsed.installed
  )
    throw new Error(`Unrecognised lock file ${file}`);
  return parsed;
}

// Atomic: a crash mid-write leaves the previous lock, never a truncated one.
export async function writeLock(file: string, lock: LockFile): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const sorted: LockFile = {
    lockVersion: 1,
    installed: Object.fromEntries(
      Object.entries(lock.installed).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(sorted, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, file);
}
