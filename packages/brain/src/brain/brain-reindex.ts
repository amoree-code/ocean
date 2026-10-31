import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrainConformance } from "@ocean/core/domain/brain/brain-record.js";
import type {
  BrainIndexPort,
  IndexDocInput,
  IndexLinkInput,
} from "@ocean/core/domain/ports/brain-index-port.js";
import type { EmbedderPort } from "@ocean/core/domain/ports/embedder-port.js";
import {
  INDEX_DIR,
  KNOWLEDGE_DIR,
  oceanRoot,
  PROJECTS_DIR,
  resolveWithin,
  STORE_DIR,
} from "@ocean/core/shared/paths.js";
import {
  basenameStem,
  chunkBody,
  extractWikilinks,
  normalizeForSearch,
  normalizeRecord,
} from "./brain-markdown.js";

const STORES = ["memory", "knowledge"] as const;
const MAX_FILES = 10_000;

async function walk(root: string, depth = 0): Promise<string[]> {
  if (depth === 0) {
    try {
      await stat(root);
    } catch {
      return [];
    }
  }
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      if (entry.name === "archive") continue;
      files.push(...(await walk(path.join(root, entry.name), depth + 1)));
      continue;
    }
    if (entry.name.endsWith(".md")) files.push(path.join(root, entry.name));
  }
  return files;
}

// Every indexed markdown file as (store prefix, store path, file): the memory and knowledge
// stores, and each project's memory folder as `project/<id>/…` (T-296) — scoped to that
// project unless the record declares otherwise. `_template` and dot folders are not projects.
type CorpusFile = { prefix: string; storePath: string; file: string };

async function corpusFiles(root: string): Promise<CorpusFile[]> {
  const found: CorpusFile[] = [];
  const add = async (prefix: string, storeRoot: string) => {
    for (const file of await walk(storeRoot))
      found.push({
        prefix,
        storePath: `${prefix}/${path.relative(storeRoot, file).split(path.sep).join("/")}`,
        file,
      });
  };
  for (const store of STORES)
    await add(store, resolveWithin(root, STORE_DIR[store]));
  const projects = await readdir(resolveWithin(root, PROJECTS_DIR), {
    withFileTypes: true,
  }).catch(() => []);
  for (const entry of projects.sort((a, b) => a.name.localeCompare(b.name)))
    if (
      entry.isDirectory() &&
      !entry.name.startsWith(".") &&
      !entry.name.startsWith("_")
    )
      await add(
        `project/${entry.name}`,
        resolveWithin(root, PROJECTS_DIR, entry.name, "memory"),
      );
  return found;
}

// Cheap staleness probe: hashes every indexed markdown file's bytes, in the same (sorted path,
// sha256) shape reindexBrain folds into meta.corpus_hash, without parsing frontmatter or
// building chunks. Used by brainSearch to report `stale: true` when the index is older than the
// files it was built from, without paying for a full reindex on every search.
export async function computeCorpusHash(root = oceanRoot()): Promise<string> {
  const entries: Array<{ storePath: string; contentHash: string }> = [];
  for (const { storePath, file } of await corpusFiles(root)) {
    const source = await readFile(file, "utf8");
    entries.push({
      storePath,
      contentHash: createHash("sha256").update(source).digest("hex"),
    });
  }
  entries.sort((a, b) => a.storePath.localeCompare(b.storePath));
  return createHash("sha256")
    .update(
      entries
        .map((entry) => `${entry.storePath}:${entry.contentHash}`)
        .join("\n"),
    )
    .digest("hex");
}

type WalkedDoc = {
  storePath: string; // "memory/foo.md" | "knowledge/decisions/bar.md" | "project/p/x.md"
  store: string; // the store prefix: "memory" | "knowledge" | "project/<id>"
  record: ReturnType<typeof normalizeRecord>["record"];
  conformance: BrainConformance;
  rawScope: string | undefined;
  body: string;
  contentHash: string;
  bytes: number;
  links: { targetRaw: string; heading: string | null; alias: string | null }[];
};

export type ReindexOptions = {
  root?: string;
  embedder?: EmbedderPort | null;
  indexPort: BrainIndexPort;
};

export type ReindexResult = {
  docs: number;
  chunks: number;
  links: number;
  danglingLinks: Array<{ source: string; target: string }>;
  ambiguousLinks: Array<{ source: string; target: string }>;
  conformance: Record<string, { aliased: number; defaulted: number }>;
  scopes: Record<string, number>;
  invalidScopes: Array<{ path: string; scope: string }>;
  legacyIndexPresent: boolean;
  vectors: boolean;
  outFile: string;
};

// Resolves one wikilink target to a store-relative doc path, per the fixed precedence order:
// exact declared id anywhere in the corpus, the same store's `<target>.md`, that store's
// `<target>/README.md`, then a corpus-wide unique file stem. Anything else is dangling.
// Exactly two or more stem matches is reported separately as ambiguous, not silently guessed.
function resolveLink(
  targetRaw: string,
  sourceStore: string,
  byId: Map<string, string>,
  byPath: Map<string, string>,
  byStem: Map<string, string[]>,
): { resolved: string | null; ambiguous: boolean } {
  const cleaned = targetRaw.replace(/^\.\//, "");
  const declaredId = byId.get(cleaned);
  if (declaredId !== undefined)
    return { resolved: declaredId, ambiguous: false };
  const storeRelative = `${sourceStore}/${cleaned}.md`;
  if (byPath.has(storeRelative))
    return { resolved: storeRelative, ambiguous: false };
  const readmePath = `${sourceStore}/${cleaned}/README.md`;
  if (byPath.has(readmePath)) return { resolved: readmePath, ambiguous: false };
  const stem = cleaned.split("/").pop() ?? cleaned;
  const stemMatches = byStem.get(stem) ?? [];
  if (stemMatches.length === 1)
    return { resolved: stemMatches[0], ambiguous: false };
  if (stemMatches.length > 1) return { resolved: null, ambiguous: true };
  return { resolved: null, ambiguous: false };
}

export async function reindexBrain(
  options: ReindexOptions,
): Promise<ReindexResult> {
  const root = options.root ?? oceanRoot();
  const embedder = options.embedder ?? null;

  const walked: WalkedDoc[] = [];
  let totalSeen = 0;
  for (const { prefix: store, storePath: relative, file } of await corpusFiles(
    root,
  )) {
    totalSeen += 1;
    if (totalSeen > MAX_FILES)
      throw new Error(
        `brain reindex found more than ${MAX_FILES} markdown files — refusing to index an unbounded corpus`,
      );
    const source = await readFile(file, "utf8");
    const { record, conformance, body, rawScope } = normalizeRecord(
      relative,
      source,
    );
    const links = extractWikilinks(body).map((link) => ({
      targetRaw: link.target,
      heading: link.heading,
      alias: link.alias,
    }));
    walked.push({
      storePath: relative,
      store,
      record,
      conformance,
      rawScope,
      body,
      contentHash: createHash("sha256").update(source).digest("hex"),
      bytes: Buffer.byteLength(source, "utf8"),
      links,
    });
  }
  walked.sort((a, b) => a.storePath.localeCompare(b.storePath));

  // Duplicate *declared* ids fail loudly — a collision between two files whose ids only
  // coincide because both defaulted to their own path can never happen (paths are unique).
  const declaredIds = new Map<string, string>();
  for (const doc of walked) {
    if (doc.conformance.id === "defaulted") continue;
    const existing = declaredIds.get(doc.record.id);
    if (existing) {
      throw new Error(
        `duplicate brain record id '${doc.record.id}' declared in both ${existing} and ${doc.storePath}`,
      );
    }
    declaredIds.set(doc.record.id, doc.storePath);
  }

  const byId = new Map<string, string>();
  const byPath = new Map<string, string>();
  const byStem = new Map<string, string[]>();
  for (const doc of walked) {
    byId.set(doc.record.id, doc.storePath);
    byPath.set(doc.storePath, doc.storePath);
    const stem = basenameStem(doc.storePath);
    byStem.set(stem, [...(byStem.get(stem) ?? []), doc.storePath]);
  }

  const docInputs: IndexDocInput[] = [];
  const linkInputs: IndexLinkInput[] = [];
  const danglingLinks: Array<{ source: string; target: string }> = [];
  const ambiguousLinks: Array<{ source: string; target: string }> = [];
  const conformanceTally: Record<
    string,
    { aliased: number; defaulted: number }
  > = {};
  const scopeTally: Record<string, number> = {};
  const invalidScopes: Array<{ path: string; scope: string }> = [];
  let chunkCount = 0;

  for (const doc of walked) {
    scopeTally[doc.record.scope] = (scopeTally[doc.record.scope] ?? 0) + 1;
    if (doc.record.scope === "invalid")
      invalidScopes.push({ path: doc.storePath, scope: doc.rawScope ?? "" });
    for (const [field, state] of Object.entries(doc.conformance)) {
      conformanceTally[field] ??= { aliased: 0, defaulted: 0 };
      if (state === "aliased") conformanceTally[field].aliased += 1;
      if (state === "defaulted") conformanceTally[field].defaulted += 1;
    }
    const chunks = chunkBody(doc.body);
    chunkCount += chunks.length;
    docInputs.push({
      id: doc.record.id,
      path: doc.storePath,
      title: doc.record.title,
      summary: doc.record.summary,
      tags: doc.record.tags,
      type: doc.record.type,
      scope: doc.record.scope,
      confidence: doc.record.confidence,
      created: doc.record.created,
      updated: doc.record.updated,
      lastConfirmedAt: doc.record.lastConfirmedAt,
      contentHash: doc.contentHash,
      bytes: doc.bytes,
      conformance: doc.conformance,
      chunks: chunks.map((chunk) => ({
        ordinal: chunk.ordinal,
        heading: chunk.heading,
        text: chunk.text,
        normalizedText: normalizeForSearch(chunk.text),
      })),
    });
    for (const link of doc.links) {
      const { resolved, ambiguous } = resolveLink(
        link.targetRaw,
        doc.store,
        byId,
        byPath,
        byStem,
      );
      if (ambiguous)
        ambiguousLinks.push({ source: doc.storePath, target: link.targetRaw });
      else if (!resolved)
        danglingLinks.push({ source: doc.storePath, target: link.targetRaw });
      linkInputs.push({
        sourcePath: doc.storePath,
        targetRaw: link.targetRaw,
        targetPath: resolved,
      });
    }
  }

  const corpusHash = createHash("sha256")
    .update(
      walked.map((doc) => `${doc.storePath}:${doc.contentHash}`).join("\n"),
    )
    .digest("hex");

  const outDir = resolveWithin(root, INDEX_DIR);
  const outFile = path.join(outDir, "brain.sqlite");
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, ".gitignore"), "*\n");

  await options.indexPort.buildIndex(docInputs, linkInputs, outFile, {
    corpusHash,
    embedder,
  });

  let legacyIndexPresent = false;
  try {
    await stat(resolveWithin(root, KNOWLEDGE_DIR, "index.sqlite3"));
    legacyIndexPresent = true;
  } catch {
    legacyIndexPresent = false;
  }

  return {
    docs: docInputs.length,
    chunks: chunkCount,
    links: linkInputs.length,
    danglingLinks,
    ambiguousLinks,
    conformance: conformanceTally,
    scopes: scopeTally,
    invalidScopes,
    legacyIndexPresent,
    vectors: Boolean(embedder),
    outFile,
  };
}

export function brainIndexPath(root = oceanRoot()): string {
  return path.join(root, INDEX_DIR, "brain.sqlite");
}
