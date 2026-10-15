import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  scopeVisible,
  visibleScopes,
} from "../../domain/brain/record-scope.js";
import {
  BRAIN_INDEX_SCHEMA_VERSION,
  type BrainIndexPort,
  type BrainIndexReaderPort,
} from "../../domain/ports/brain-index-port.js";
import type { EmbedderPort } from "../../domain/ports/embedder-port.js";
import {
  oceanRoot,
  resolveStorePath,
  resolveWithin,
  STORE_DIR,
} from "../../paths.js";
import { normalizeForSearch, normalizeRecord } from "./brain-markdown.js";
import {
  brainIndexPath,
  computeCorpusHash,
  reindexBrain,
} from "./brain-reindex.js";

// Which project's records a caller may see. Absent = unfiltered (brain_read, tooling);
// `project: null` = unbound session, global records only.
export type BrainScopeFilter = { project: string | null };

// A v1 index has no scope column, so it cannot answer a scoped query: say how to fix it
// rather than return unfiltered hits.
export class BrainIndexStaleError extends Error {}

function assertScoped(reader: BrainIndexReaderPort): void {
  if (reader.meta.schemaVersion !== BRAIN_INDEX_SCHEMA_VERSION)
    throw new BrainIndexStaleError(
      `brain index schema ${reader.meta.schemaVersion} predates record scopes — run \`ocean memory reindex\``,
    );
}

export type BrainSearchOptions = {
  query: string;
  limit?: number;
  types?: string[];
  root?: string;
  pathPrefix?: string;
  scope?: BrainScopeFilter;
  embedder?: EmbedderPort | null;
  indexPort: BrainIndexPort;
};

export type BrainSearchHit = {
  id: string;
  path: string;
  title: string;
  summary: string;
  type: string;
  scope: string;
  confidence: string;
  lastConfirmedAt: string | null;
  heading: string | null;
  snippet: string;
  score: number;
  matchedBy: "fts" | "vector" | "both";
};

export type BrainSearchResult = {
  mode: "hybrid" | "fts";
  stale: boolean;
  vector: string;
  results: BrainSearchHit[];
};

const RRF_K = 60;

function snippetOf(text: string, maxLen = 240): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen - 1)}…` : trimmed;
}

export async function brainSearch(
  options: BrainSearchOptions,
): Promise<BrainSearchResult> {
  const root = options.root ?? oceanRoot();
  const limit = Math.max(1, Math.min(20, options.limit ?? 8));
  const indexFile = brainIndexPath(root);
  let exists = true;
  try {
    await stat(indexFile);
  } catch {
    exists = false;
  }
  if (!exists) {
    throw new Error("brain index not built — run ocean memory reindex");
  }

  const reader = options.indexPort.openIndexReadOnly(indexFile);
  try {
    if (options.scope) assertScoped(reader);
    const scopes = options.scope
      ? visibleScopes(options.scope.project)
      : undefined;
    const normalizedQuery = normalizeForSearch(options.query);
    const ftsHits = reader.ftsQuery(normalizedQuery, limit * 4, scopes);

    let vecHits: { chunkId: number; docId: number; distance: number }[] = [];
    let vectorStatus = "unavailable: index built without an embedder";
    if (reader.hasVectors && options.embedder) {
      try {
        const [embedding] = await options.embedder.embed([normalizedQuery]);
        // KNN cannot filter by scope before k, so a scoped query oversamples: other projects'
        // chunks would otherwise fill the top hits and the backstop below would drop them all.
        vecHits = reader.vecQuery(
          embedding,
          options.scope ? limit * 16 : limit * 4,
        );
        vectorStatus = "ok";
      } catch (error) {
        vectorStatus = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    } else if (reader.hasVectors && !options.embedder) {
      vectorStatus = "unavailable: no embedder supplied to this query";
    }

    // Reciprocal rank fusion: rank position (1-based), not raw score, so bm25 and cosine
    // distance — on incompatible scales — combine without one dominating by magnitude.
    const fused = new Map<
      number,
      { docId: number; score: number; fts: boolean; vec: boolean }
    >();
    ftsHits.forEach((hit, index) => {
      const entry = fused.get(hit.chunkId) ?? {
        docId: hit.docId,
        score: 0,
        fts: false,
        vec: false,
      };
      entry.score += 1 / (RRF_K + index + 1);
      entry.fts = true;
      fused.set(hit.chunkId, entry);
    });
    vecHits.forEach((hit, index) => {
      const entry = fused.get(hit.chunkId) ?? {
        docId: hit.docId,
        score: 0,
        fts: false,
        vec: false,
      };
      entry.score += 1 / (RRF_K + index + 1);
      entry.vec = true;
      fused.set(hit.chunkId, entry);
    });

    const byDoc = new Map<
      number,
      { chunkId: number; score: number; fts: boolean; vec: boolean }
    >();
    for (const [chunkId, entry] of fused) {
      const existing = byDoc.get(entry.docId);
      if (!existing || entry.score > existing.score) {
        byDoc.set(entry.docId, {
          chunkId,
          score: entry.score,
          fts: entry.fts,
          vec: entry.vec,
        });
      }
    }

    const ranked = [...byDoc.entries()]
      .map(([docId, entry]) => ({ docId, ...entry }))
      .sort((a, b) => b.score - a.score || a.docId - b.docId);

    const results: BrainSearchHit[] = [];
    for (const item of ranked) {
      const doc = reader.getDoc(item.docId);
      if (!doc) continue;
      if (
        options.pathPrefix &&
        !String(doc.path).startsWith(options.pathPrefix)
      )
        continue;
      if (options.types?.length && !options.types.includes(String(doc.type)))
        continue;
      // Backstop for hits the SQL filter never saw (vector hits are not scope-filtered).
      if (
        options.scope &&
        !scopeVisible(String(doc.scope), options.scope.project)
      )
        continue;
      const chunk = reader.getChunk(item.chunkId);
      results.push({
        id: String(doc.id),
        path: String(doc.path),
        title: String(doc.title),
        summary: String(doc.summary),
        type: String(doc.type),
        scope: String(doc.scope ?? "global"),
        confidence: String(doc.confidence),
        lastConfirmedAt: (doc.last_confirmed_at as string | null) ?? null,
        heading: chunk ? ((chunk.heading as string | null) ?? null) : null,
        snippet: chunk ? snippetOf(String(chunk.text)) : "",
        score: Math.round(item.score * 1_000_000) / 1_000_000,
        matchedBy: item.fts && item.vec ? "both" : item.vec ? "vector" : "fts",
      });
      if (results.length >= limit) break;
    }

    const stale = reader.meta.corpusHash !== (await computeCorpusHash(root));
    return {
      mode:
        reader.hasVectors && options.embedder && vectorStatus === "ok"
          ? "hybrid"
          : "fts",
      stale,
      vector: vectorStatus,
      results,
    };
  } finally {
    reader.close();
  }
}

export type BrainReadOptions = {
  idOrPath: string;
  maxBytes?: number;
  root?: string;
  indexPort: BrainIndexPort;
};

export type BrainReadResult = {
  id: string;
  path: string;
  title: string;
  summary: string;
  tags: string[];
  type: string;
  scope: string;
  confidence: string;
  created: string | null;
  updated: string | null;
  lastConfirmedAt: string | null;
  body: string;
  truncated: boolean;
};

// Always reads the markdown FILE, never the index row — the index can be stale or (in a
// test) deliberately tampered with, and brain_read must never surface a lie about what's on
// disk. The index is used only to resolve id -> path.
export async function brainRead(
  options: BrainReadOptions,
): Promise<BrainReadResult> {
  const root = options.root ?? oceanRoot();
  const maxBytes = Math.max(512, Math.min(16_000, options.maxBytes ?? 8_000));
  const indexFile = brainIndexPath(root);
  const reader = options.indexPort.openIndexReadOnly(indexFile);
  let docRow: Record<string, unknown> | undefined;
  try {
    docRow = reader.getDocByIdOrPath(options.idOrPath);
  } finally {
    reader.close();
  }
  if (!docRow)
    throw new Error(`no brain record found for '${options.idOrPath}'`);

  // The index is only ever used above to resolve id/path -> the store-relative path. Every
  // field returned below is re-derived from the file's own bytes on disk (normalizeRecord),
  // never from the (possibly stale or tampered) index row — this is what makes brain_read
  // safe to trust even when the index itself cannot be.
  const relativePath = String(docRow.path);
  const filePath = resolveStorePath(root, relativePath);
  const raw = await readFile(filePath, "utf8");
  const { record, body } = normalizeRecord(relativePath, raw);

  const truncated = Buffer.byteLength(body, "utf8") > maxBytes;
  const slicedBody = truncated
    ? Buffer.from(body).subarray(0, maxBytes).toString("utf8")
    : body;

  return {
    id: record.id,
    path: relativePath,
    title: record.title,
    summary: record.summary,
    tags: record.tags,
    type: record.type,
    scope: record.scope,
    confidence: record.confidence,
    created: record.created,
    updated: record.updated,
    lastConfirmedAt: record.lastConfirmedAt,
    body: slicedBody,
    truncated,
  };
}

export type BrainNeighborsOptions = {
  idOrPath: string;
  depth?: 1 | 2;
  direction?: "out" | "in" | "both";
  limit?: number;
  root?: string;
  scope?: BrainScopeFilter;
  indexPort: BrainIndexPort;
};

export type BrainNeighbor = {
  id: string;
  path: string;
  title: string;
  via: "out" | "in";
};

export async function brainNeighbors(
  options: BrainNeighborsOptions,
): Promise<{ neighbors: BrainNeighbor[] }> {
  const root = options.root ?? oceanRoot();
  const depth = options.depth ?? 1;
  const direction = options.direction ?? "both";
  const limit = Math.max(1, Math.min(50, options.limit ?? 20));
  const indexFile = brainIndexPath(root);
  const reader = options.indexPort.openIndexReadOnly(indexFile);
  try {
    if (options.scope) assertScoped(reader);
    const visible = (doc: Record<string, unknown>) =>
      !options.scope || scopeVisible(String(doc.scope), options.scope.project);
    const start = reader.getDocByIdOrPath(options.idOrPath);
    if (!start || !visible(start))
      throw new Error(`no brain record found for '${options.idOrPath}'`);

    const visited = new Set<number>([Number(start.doc_id)]);
    const neighbors: BrainNeighbor[] = [];
    let frontier = [Number(start.doc_id)];
    for (let level = 0; level < depth && neighbors.length < limit; level += 1) {
      const next: number[] = [];
      for (const docId of frontier) {
        const directions: Array<"out" | "in"> =
          direction === "both" ? ["out", "in"] : [direction];
        for (const dir of directions) {
          for (const link of reader.linksFor(docId, dir)) {
            const targetId =
              dir === "out" ? link.targetDocId : link.sourceDocId;
            if (
              targetId === null ||
              targetId === undefined ||
              visited.has(targetId)
            )
              continue;
            visited.add(targetId);
            const doc = reader.getDoc(targetId);
            if (!doc || !visible(doc)) continue;
            neighbors.push({
              id: String(doc.id),
              path: String(doc.path),
              title: String(doc.title),
              via: dir,
            });
            next.push(targetId);
            if (neighbors.length >= limit) break;
          }
          if (neighbors.length >= limit) break;
        }
        if (neighbors.length >= limit) break;
      }
      frontier = next;
    }
    return { neighbors };
  } finally {
    reader.close();
  }
}

export async function ensureIndexBuilt(root = oceanRoot()): Promise<boolean> {
  try {
    await stat(brainIndexPath(root));
    return true;
  } catch {
    return false;
  }
}

export { reindexBrain };
export function relativeStorePath(file: string, root = oceanRoot()): string {
  for (const [store, dir] of Object.entries(STORE_DIR)) {
    const relative = path.relative(resolveWithin(root, dir), file);
    if (!relative.startsWith("..") && !path.isAbsolute(relative))
      return `${store}/${relative.split(path.sep).join("/")}`;
  }
  return path.relative(root, file).split(path.sep).join("/");
}
