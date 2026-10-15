import { readFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { oceanPath, STORE_DIR } from "../../paths.js";

type Store = "memory" | "knowledge";
const generatedStart = "## Records (generated)";

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name === "archive") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(full)));
    else if (entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

function title(content: string, fallback: string): string {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/m)?.[1] ?? "";
  const declared = frontmatter
    .match(/^(?:title|name):\s*["']?(.+?)["']?\s*$/m)?.[1]
    ?.trim();
  if (declared) return declared;
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (
    heading &&
    !/^(decision|discovery|failure|solution|research|result|architecture)$/i.test(
      heading,
    )
  )
    return heading;
  const summary = content
    .replace(/^---[\s\S]*?---\s*/m, "")
    .split("\n")
    .map((line) => line.trim())
    .find(
      (line) =>
        line &&
        !line.startsWith("#") &&
        !line.startsWith("`") &&
        !line.startsWith("|") &&
        !line.startsWith("-"),
    );
  if (summary) return summary.replace(/[*_`]/g, "").slice(0, 120);
  return (
    fallback.split("/").at(-1)?.replace(/\.md$/, "").replace(/[-_]+/g, " ") ??
    fallback
  );
}

function relativeRecord(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function links(content: string): Set<string> {
  return new Set(
    [...content.matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/g)].map(
      (match) => match[1],
    ),
  );
}

async function syncStore(store: Store, apply: boolean) {
  const root = oceanPath(STORE_DIR[store]);
  const indexName = store === "memory" ? "MEMORY.md" : "KNOWLEDGE.md";
  const index = path.join(root, indexName);
  const current = await readFile(index, "utf8");
  const recordFiles = (await markdownFiles(root)).filter(
    (file) => path.basename(file) !== indexName,
  );
  const known = links(current);
  const missing = recordFiles.filter(
    (file) => !known.has(relativeRecord(root, file)),
  );
  const broken: string[] = [];
  for (const link of known) {
    if (
      !link.startsWith("http") &&
      !(await awaitedExists(path.resolve(root, link)))
    )
      broken.push(link);
  }
  if (!apply)
    return {
      store,
      missing: missing.map((file) => relativeRecord(root, file)),
      broken,
      changed: false,
    };

  const generated = [
    generatedStart,
    "",
    ...recordFiles.map((file) => {
      const relative = relativeRecord(root, file);
      return `- [${title(readFileSync(file, "utf8"), relative)}](${relative})`;
    }),
  ].join("\n");
  const next = current.includes(generatedStart)
    ? `${current.slice(0, current.indexOf(generatedStart)).trimEnd()}\n\n${generated}\n`
    : `${current.trimEnd()}\n\n${generated}\n`;
  const changed = next !== current;
  if (changed) await writeFile(index, next);
  return {
    store,
    missing: missing.map((file) => relativeRecord(root, file)),
    broken,
    changed,
  };
}

async function awaitedExists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

export async function syncMemoryIndexes(apply: boolean) {
  return Promise.all([
    syncStore("memory", apply),
    syncStore("knowledge", apply),
  ]);
}

export async function doctorMemoryIndexes() {
  const results = await syncMemoryIndexes(false);
  const missing = results.flatMap((result) =>
    result.missing.map((file) => `${result.store}/${file}`),
  );
  const broken = results.flatMap((result) =>
    result.broken.map((file) => `${result.store}/${file}`),
  );
  return { ok: missing.length === 0 && broken.length === 0, missing, broken };
}
