import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { isValidProjectId } from "@ocean/core/domain/context/project-id.js";
import { containsKnownSecret } from "@ocean/core/domain/redaction/redaction.js";
import { atomicWrite, withFileLock } from "@ocean/core/shared/fs-utils.js";
import {
  oceanPath,
  PERSONAL_DIR,
  PROJECTS_DIR,
  resolveWithin,
} from "@ocean/core/shared/paths.js";
import { syncMemoryIndexes } from "./index-sync.js";

const maxRecordBytes = 32_000;

export type MemoryWriteMode = "create" | "update";

// The two places a client may write a memory record: the personal store, or one project's
// memory folder. Anything else (tasks, knowledge, charter, the index itself) is refused.
function memoryTarget(relative: string): { file: string; personal: boolean } {
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  if (path.isAbsolute(relative) || !relative.endsWith(".md") || !parts.length)
    throw new Error("path must be a relative .md path");
  if (parts.includes("..") || parts.includes("."))
    throw new Error("Path escapes its allowed root");
  if (parts.at(-1) === "MEMORY.md")
    throw new Error("MEMORY.md is an index, not a record");
  const normalized = parts.join("/");
  const under = (dir: string) =>
    normalized.startsWith(`${dir}/`)
      ? normalized.slice(dir.length + 1).split("/")
      : null;
  const inPersonal = under(PERSONAL_DIR);
  if (inPersonal)
    return {
      file: resolveWithin(oceanPath(PERSONAL_DIR), ...inPersonal),
      personal: true,
    };
  const [project, folder, ...rest] = under(PROJECTS_DIR) ?? [];
  if (
    project &&
    folder === "memory" &&
    rest.length &&
    isValidProjectId(project)
  )
    return {
      file: resolveWithin(oceanPath(PROJECTS_DIR, project, "memory"), ...rest),
      personal: false,
    };
  throw new Error(
    `memory records live under ${PERSONAL_DIR}/ or ${PROJECTS_DIR}/<project>/memory/`,
  );
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// Search-first writing is the caller's job: `create` refuses an existing record and `update`
// refuses a missing one, so a client that skipped the search cannot silently fork or clobber.
export async function writeMemoryRecord(options: {
  path: string;
  content: string;
  mode: MemoryWriteMode;
}): Promise<{ path: string; mode: MemoryWriteMode; indexed: boolean }> {
  const { file, personal } = memoryTarget(options.path);
  if (!options.content.trim()) throw new Error("content is empty");
  if (Buffer.byteLength(options.content) > maxRecordBytes)
    throw new Error(`content exceeds ${maxRecordBytes} bytes`);
  if (containsKnownSecret(options.content))
    throw new Error("content holds a secret; memory never stores one");
  await mkdir(path.dirname(file), { recursive: true });
  await withFileLock(file, async () => {
    const present = await exists(file);
    if (options.mode === "create" && present)
      throw new Error(
        "record already exists; read it and write it back with mode update",
      );
    if (options.mode === "update" && !present)
      throw new Error("record does not exist; use mode create");
    await atomicWrite(
      file,
      options.content.endsWith("\n") ? options.content : `${options.content}\n`,
    );
  });
  if (personal) await syncMemoryIndexes(true);
  return {
    path: path.relative(oceanPath(), file).split(path.sep).join("/"),
    mode: options.mode,
    indexed: personal,
  };
}
