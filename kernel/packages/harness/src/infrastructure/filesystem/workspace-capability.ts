import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { workspaceReadContract } from "@ocean/core/domain/capabilities/capability-contract.js";

export type WorkspaceReadResult = {
  contract: typeof workspaceReadContract;
  path: string;
  bytes: number;
  sha256: string;
  content: string;
};

export async function readWorkspaceFile(
  root: string,
  relativePath: string,
  allowedPaths: string[],
  maxBytes = 32_000,
  timeoutMs = 5_000,
): Promise<WorkspaceReadResult> {
  const absolute = path.resolve(root, relativePath);
  const allowed = allowedPaths.some((allowedPath) => {
    const boundary = path.resolve(root, allowedPath);
    return (
      absolute === boundary || absolute.startsWith(`${boundary}${path.sep}`)
    );
  });
  if (!allowed)
    throw new Error(`Capability denied outside allowed paths: ${relativePath}`);
  if (timeoutMs <= 0) throw new Error(`Capability timed out: ${relativePath}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let content: string;
  try {
    content = (
      await readFile(absolute, { encoding: "utf8", signal: controller.signal })
    ).slice(0, maxBytes);
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error(`Capability timed out: ${relativePath}`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  return {
    contract: workspaceReadContract,
    path: relativePath,
    bytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
    content,
  };
}
