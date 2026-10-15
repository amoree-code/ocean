import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { oceanPath, SYSTEM_DIR } from "../../paths.js";
import type { ObsidianConnection } from "./vault-discovery.js";

const MAX_CONTENT_BYTES = 1_000_000;

export type ObsidianWriteResult = {
  applied: boolean;
  path: string;
  sha256?: string;
  conflict?: {
    record: string;
    expectedSha256: string | null;
    actualSha256: string | null;
  };
};

export function resolveObsidianNotePath(
  vaultPath: string,
  relative: string,
): string {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).includes("..") ||
    !relative.endsWith(".md")
  ) {
    throw new Error(
      "Obsidian write path must be a relative Markdown file inside the vault",
    );
  }
  const resolved = path.resolve(vaultPath, relative);
  if (
    !resolved.startsWith(`${path.resolve(vaultPath)}${path.sep}`) ||
    relative.split(/[\\/]/).some((part) => part.startsWith("."))
  ) {
    throw new Error(
      "Obsidian write path cannot target hidden metadata or escape the vault",
    );
  }
  return resolved;
}

function hash(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function recordConflict(
  relative: string,
  expectedSha256: string | null,
  actualSha256: string | null,
  content: string,
  conflictsDirectory = oceanPath(
    SYSTEM_DIR,
    "integrations",
    "obsidian",
    "conflicts",
  ),
): Promise<string> {
  const directory = conflictsDirectory;
  await mkdir(directory, { recursive: true });
  const record = path.join(
    directory,
    `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}.json`,
  );
  await writeFile(
    record,
    `${JSON.stringify({ version: 1, path: relative, expectedSha256, actualSha256, proposedContent: content, createdAt: new Date().toISOString() }, null, 2)}\n`,
  );
  return record;
}

export async function writeObsidianNote(
  connection: ObsidianConnection,
  relative: string,
  content: string,
  expectedSha256: string | null = null,
  apply = false,
  conflictsDirectory?: string,
): Promise<ObsidianWriteResult> {
  const file = resolveObsidianNotePath(connection.vaultPath, relative);
  if (Buffer.byteLength(content) > MAX_CONTENT_BYTES)
    throw new Error(`Obsidian note exceeds ${MAX_CONTENT_BYTES} bytes`);
  let current: Buffer | null = null;
  try {
    current = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const actualSha256 = current ? hash(current) : null;
  if (current && actualSha256 !== expectedSha256) {
    const record = await recordConflict(
      relative,
      expectedSha256,
      actualSha256,
      content,
      conflictsDirectory,
    );
    return {
      applied: false,
      path: relative,
      conflict: { record, expectedSha256, actualSha256 },
    };
  }
  if (!current && expectedSha256 !== null) {
    const record = await recordConflict(
      relative,
      expectedSha256,
      null,
      content,
      conflictsDirectory,
    );
    return {
      applied: false,
      path: relative,
      conflict: { record, expectedSha256, actualSha256: null },
    };
  }
  if (!apply) return { applied: false, path: relative, sha256: hash(content) };
  if (connection.mode !== "read-write")
    throw new Error(
      "Obsidian connection is read-only; use an explicit read-write connection before applying a write",
    );
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.ocean-tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return { applied: true, path: relative, sha256: hash(content) };
}
