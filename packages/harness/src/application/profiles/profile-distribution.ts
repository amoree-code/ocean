import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  type ProfileDistribution,
  validateProfileDistribution,
} from "@ocean/core/domain/profiles/profile-distribution.js";

const forbidden = new Set([
  ".env",
  ".env.example",
  "auth.json",
  "memories",
  "sessions",
  "logs",
  "workspace",
  "home",
  "state.db",
  "state.db-shm",
  "state.db-wal",
]);

export async function loadProfileDistribution(
  root: string,
): Promise<ProfileDistribution> {
  const manifest = JSON.parse(
    await readFile(path.join(root, "distribution.yaml"), "utf8"),
  );
  const distribution = validateProfileDistribution(manifest);
  const files = distribution.files.length
    ? distribution.files
    : await listFiles(root);
  for (const file of files) {
    if (isForbidden(file))
      throw new Error(
        `Profile distribution contains forbidden private state: ${file}`,
      );
    const resolved = path.resolve(root, file);
    const rootPath = path.resolve(root);
    if (
      resolved !== rootPath &&
      !resolved.startsWith(`${rootPath}${path.sep}`)
    ) {
      throw new Error(
        `Profile distribution file escapes package root: ${file}`,
      );
    }
    await stat(resolved);
  }
  return { ...distribution, files };
}

function isForbidden(file: string): boolean {
  return file
    .split(/[\\/]/)
    .some((part) => forbidden.has(part) || part.startsWith(".env"));
}

async function listFiles(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(root, child)));
    else result.push(child);
  }
  return result;
}
