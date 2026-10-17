import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { resolveWithin } from "@ocean/core/shared/paths.js";

// A directory the marketplace installed carries this marker. Anything without it — a core
// skill, something the owner made by hand — is never overwritten or removed by an adapter.
const MARKER = ".ocean-capability.json";

export type Owner = { name: string; version: string };

const directoryName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function expectDirectoryName(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !directoryName.test(value) ||
    value.includes("..")
  )
    throw new Error(`${field} must be a plain directory name`);
  return value;
}

export function expectRecord(
  value: unknown,
  what: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${what} must be an object`);
  return value as Record<string, unknown>;
}

async function markerOwner(directory: string): Promise<string | undefined> {
  try {
    return (
      JSON.parse(await readFile(path.join(directory, MARKER), "utf8")) as Owner
    ).name;
  } catch {
    return undefined;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function installOwnedDirectory(
  root: string,
  name: string,
  contentDir: string,
  owner: Owner,
): Promise<string> {
  await mkdir(root, { recursive: true });
  const target = resolveWithin(root, name);
  if (await exists(target)) {
    const current = await markerOwner(target);
    if (current !== owner.name)
      throw new Error(
        `${target} already exists and is ${current ? `owned by ${current}` : "not managed by the marketplace"}; refusing to overwrite it`,
      );
  }
  const staging = resolveWithin(root, `.${name}.${randomUUID()}.staging`);
  try {
    await cp(contentDir, staging, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await writeFile(path.join(staging, MARKER), `${JSON.stringify(owner)}\n`);
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return target;
}

// Missing is fine (already gone); owned by someone else is refused.
export async function removeOwnedDirectory(
  root: string,
  name: string,
  owner: string,
): Promise<void> {
  const target = resolveWithin(root, name);
  if (!(await exists(target))) return;
  const current = await markerOwner(target);
  if (current !== owner)
    throw new Error(
      `${target} is ${current ? `owned by ${current}` : "not managed by the marketplace"}; refusing to remove it`,
    );
  await rm(target, { recursive: true, force: true });
}

// Every markdown file in a payload: what a model reads from a skill or a plugin.
export async function markdownTexts(
  contentDir: string,
): Promise<{ source: string; text: string }[]> {
  const texts: { source: string; text: string }[] = [];
  for (const entry of await readdir(contentDir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const full = path.join(entry.parentPath, entry.name);
    texts.push({
      source: path.relative(contentDir, full),
      text: await readFile(full, "utf8"),
    });
  }
  return texts;
}
