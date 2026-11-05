import { access, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import {
  discoverObsidianVault,
  type ObsidianConnection,
} from "./vault-discovery.js";

const roots = ["01-Projects", "02-Areas", "03-Resources", "05-Goals"];

export type InboxCandidate = {
  path: string;
  bytes: number;
  sha256: string;
  properties: Record<string, string>;
  suggestedRoot: string;
  duplicateOf: string | null;
};

function suggestion(properties: Record<string, string>): string {
  if (properties.type === "goal" || properties.domain === "goals")
    return "05-Goals";
  if (properties.type === "resource") return "03-Resources";
  if (properties.type === "project") return "01-Projects";
  if (properties.domain === "personal") return "02-Areas/Personal";
  if (properties.domain === "business") return "02-Areas/Business";
  if (properties.domain === "education") return "02-Areas/Education";
  return "03-Resources";
}

export async function listInboxCandidates(
  connection: ObsidianConnection,
): Promise<InboxCandidate[]> {
  const discovery = await discoverObsidianVault(connection);
  const byHash = new Map<string, string>();
  for (const note of discovery.notes)
    if (!byHash.has(note.sha256)) byHash.set(note.sha256, note.path);
  return discovery.notes
    .filter(
      (note) => note.path === "00-Inbox" || note.path.startsWith("00-Inbox/"),
    )
    .map((note) => ({
      path: note.path,
      bytes: note.bytes,
      sha256: note.sha256,
      properties: note.properties,
      suggestedRoot: suggestion(note.properties),
      duplicateOf:
        discovery.notes.find(
          (other) => other.sha256 === note.sha256 && other.path !== note.path,
        )?.path ?? null,
    }));
}

function safePath(root: string, relative: string): string {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).includes("..")
  )
    throw new Error(
      "Vault path must be relative and stay inside the configured vault",
    );
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`))
    throw new Error("Vault path escapes the configured vault");
  return resolved;
}

export async function promoteInboxNote(
  connection: ObsidianConnection,
  source: string,
  targetDirectory: string,
  apply = false,
): Promise<{ source: string; destination: string; applied: boolean }> {
  if (!source.startsWith("00-Inbox/"))
    throw new Error("Only notes inside 00-Inbox can be promoted");
  if (
    !roots.some(
      (root) =>
        targetDirectory === root || targetDirectory.startsWith(`${root}/`),
    )
  )
    throw new Error(`Promotion target must stay under: ${roots.join(", ")}`);
  const sourceFile = safePath(connection.vaultPath, source);
  const destinationDirectory = safePath(connection.vaultPath, targetDirectory);
  const destination = path.join(
    destinationDirectory,
    path.basename(sourceFile),
  );
  await access(sourceFile);
  if (!apply)
    return {
      source,
      destination: path.relative(connection.vaultPath, destination),
      applied: false,
    };
  if (connection.mode !== "read-write")
    throw new Error(
      "Obsidian connection is read-only; use an explicit read-write connection before applying promotion",
    );
  await mkdir(destinationDirectory, { recursive: true });
  try {
    await access(destination);
    throw new Error(
      `Promotion destination already exists: ${path.relative(connection.vaultPath, destination)}`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(sourceFile, destination);
  return {
    source,
    destination: path.relative(connection.vaultPath, destination),
    applied: true,
  };
}
