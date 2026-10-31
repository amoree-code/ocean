import { rename, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  BRAIN_INDEX_SCHEMA_VERSION,
  type BrainIndexPort,
  type BrainIndexReaderPort,
  type BuildIndexOptions,
  type FtsHit,
  type IndexDocInput,
  type IndexLinkInput,
  type IndexMeta,
  type VecHit,
} from "@ocean/core/domain/ports/brain-index-port.js";
import * as sqliteVec from "sqlite-vec";

// Sole file in the brain subsystem that imports node:sqlite (and, when vectors are enabled,
// sqlite-vec) directly — everything else in application/brain/ talks to the
// domain/ports/brain-index-port.ts contract, wired to this module only through
// composition/runtime.ts (enforced by tests/architecture.test.mjs). The index is a
// disposable, rebuildable cache: nothing here is the source of truth, and nothing outside
// `reindex` (application/brain/brain-reindex.ts) ever writes to it.

export type {
  BuildIndexOptions,
  EmbedderPort,
  FtsHit,
  IndexChunkInput,
  IndexDocInput,
  IndexLinkInput,
  IndexMeta,
  VecHit,
} from "@ocean/core/domain/ports/brain-index-port.js";

function createSchema(
  db: DatabaseSync,
  withVectors: boolean,
  dims: number,
): void {
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE docs (
      doc_id INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      type TEXT NOT NULL,
      scope TEXT NOT NULL,
      confidence TEXT NOT NULL,
      created TEXT,
      updated TEXT,
      last_confirmed_at TEXT,
      content_hash TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      conformance_json TEXT NOT NULL
    );
    CREATE TABLE chunks (
      chunk_id INTEGER PRIMARY KEY,
      doc_id INTEGER NOT NULL REFERENCES docs(doc_id),
      ordinal INTEGER NOT NULL,
      heading TEXT,
      text TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      title, heading, body,
      tokenize = "unicode61 remove_diacritics 2",
      content = ""
    );
    CREATE TABLE links (
      source_doc_id INTEGER NOT NULL REFERENCES docs(doc_id),
      target_raw TEXT NOT NULL,
      target_doc_id INTEGER,
      PRIMARY KEY (source_doc_id, target_raw)
    );
    CREATE INDEX links_target_doc_id ON links(target_doc_id);
    CREATE INDEX chunks_doc_id ON chunks(doc_id);
  `);
  if (withVectors) {
    db.exec(
      `CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[${dims}] distance_metric=cosine);`,
    );
  }
}

// Inserts sorted-by-path (docs already arrive sorted from the caller) in one transaction so
// rowids — and therefore FTS/vec0 rowids — are deterministic across an identical rebuild.
async function populate(
  db: DatabaseSync,
  docs: IndexDocInput[],
  links: IndexLinkInput[],
  options: BuildIndexOptions,
): Promise<void> {
  const insertDoc = db.prepare(`
    INSERT INTO docs (id, path, title, summary, tags_json, type, scope, confidence, created, updated,
      last_confirmed_at, content_hash, bytes, conformance_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertChunk = db.prepare(`
    INSERT INTO chunks (doc_id, ordinal, heading, text) VALUES (?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO chunks_fts (rowid, title, heading, body) VALUES (?, ?, ?, ?)
  `);
  // A document can legitimately link to the same target twice (e.g. two separate mentions
  // of [[MEMORY.md]]); the second is a no-op, not a conflict — the same (source, target_raw)
  // pair carries no extra information the second time.
  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO links (source_doc_id, target_raw, target_doc_id) VALUES (?, ?, ?)
  `);

  const pathToDocId = new Map<string, number>();
  const chunkEmbedInputs: { chunkId: bigint; text: string }[] = [];

  db.exec("BEGIN");
  try {
    for (const doc of docs) {
      insertDoc.run(
        doc.id,
        doc.path,
        doc.title,
        doc.summary,
        JSON.stringify(doc.tags),
        doc.type,
        doc.scope,
        doc.confidence,
        doc.created,
        doc.updated,
        doc.lastConfirmedAt,
        doc.contentHash,
        doc.bytes,
        JSON.stringify(doc.conformance),
      );
      const docIdRow = db.prepare("SELECT last_insert_rowid() AS id").get() as {
        id: number;
      };
      const docId = Number(docIdRow.id);
      pathToDocId.set(doc.path, docId);

      for (const chunk of doc.chunks) {
        insertChunk.run(docId, chunk.ordinal, chunk.heading, chunk.text);
        const chunkIdRow = db
          .prepare("SELECT last_insert_rowid() AS id")
          .get() as {
          id: number;
        };
        const chunkId = Number(chunkIdRow.id);
        insertFts.run(
          chunkId,
          doc.title.toLowerCase(),
          (chunk.heading ?? "").toLowerCase(),
          chunk.normalizedText,
        );
        if (options.embedder)
          chunkEmbedInputs.push({
            chunkId: BigInt(chunkId),
            text: chunk.normalizedText,
          });
      }
    }
    for (const link of links) {
      const sourceDocId = pathToDocId.get(link.sourcePath);
      if (sourceDocId === undefined) continue;
      const targetDocId = link.targetPath
        ? (pathToDocId.get(link.targetPath) ?? null)
        : null;
      insertLink.run(sourceDocId, link.targetRaw, targetDocId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  if (options.embedder && chunkEmbedInputs.length > 0) {
    const embeddings = await options.embedder.embed(
      chunkEmbedInputs.map((item) => item.text),
    );
    const insertVec = db.prepare(
      "INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)",
    );
    db.exec("BEGIN");
    try {
      chunkEmbedInputs.forEach((item, index) => {
        insertVec.run(item.chunkId, embeddings[index]);
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
    "schema_version",
    BRAIN_INDEX_SCHEMA_VERSION,
  );
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
    "embedder",
    options.embedder?.model ?? "",
  );
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
    "dims",
    String(options.embedder?.dimensions ?? 0),
  );
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
    "corpus_hash",
    options.corpusHash,
  );
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
    "built_at",
    new Date().toISOString(),
  );
}

// Builds a brand-new index file at `outFile` from scratch: writes into a sibling temp file
// and renames atomically into place, so a reader never observes a half-built index and a
// crash mid-build never corrupts whatever index was there before.
export async function buildIndex(
  docs: IndexDocInput[],
  links: IndexLinkInput[],
  outFile: string,
  options: BuildIndexOptions,
): Promise<void> {
  const temp = `${outFile}.tmp-${process.pid}-${Date.now()}`;
  await rm(temp, { force: true });
  const db = new DatabaseSync(temp, { allowExtension: true });
  try {
    if (options.embedder) sqliteVec.load(db);
    createSchema(
      db,
      Boolean(options.embedder),
      options.embedder?.dimensions ?? 0,
    );
    await populate(db, docs, links, options);
  } finally {
    db.close();
  }
  await rename(temp, outFile);
}

export class BrainIndexReader implements BrainIndexReaderPort {
  private readonly db: DatabaseSync;
  readonly meta: IndexMeta;
  readonly hasVectors: boolean;

  constructor(file: string) {
    this.db = new DatabaseSync(file, { readOnly: true, allowExtension: true });
    this.db.exec("PRAGMA query_only = ON;");
    const rows = this.db.prepare("SELECT key, value FROM meta").all() as Array<{
      key: string;
      value: string;
    }>;
    const map = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    this.meta = {
      schemaVersion: map.schema_version ?? "",
      embedder: map.embedder ?? "",
      dims: Number(map.dims ?? 0),
      corpusHash: map.corpus_hash ?? "",
      builtAt: map.built_at ?? "",
    };
    this.hasVectors = this.meta.dims > 0;
    if (this.hasVectors) sqliteVec.load(this.db);
  }

  ftsQuery(
    normalizedQuery: string,
    limit: number,
    scopes?: string[],
  ): FtsHit[] {
    // Tokens are matched as quoted prefixes (`"token"*`), ANDed together (FTS5's default):
    // exact-token phrase matching is too strict for agglutinative languages like Sorani,
    // where a query word is frequently a prefix of the inflected form actually stored.
    const words = normalizedQuery
      .split(/[^\p{L}\p{N}_-]+/u)
      .map((token) => token.trim())
      .filter(Boolean);
    const quote = (token: string) => `"${token.replace(/"/g, '""')}"*`;
    if (words.length === 0) return [];
    // Filtered in SQL, before LIMIT, so another project's records cannot crowd out the hits.
    const scopeFilter = scopes
      ? ` AND c.doc_id IN (SELECT doc_id FROM docs WHERE scope IN (${scopes.map(() => "?").join(",")}))`
      : "";
    const run = (match: string, max: number): FtsHit[] => {
      try {
        return this.db
          .prepare(`
            SELECT c.chunk_id AS chunkId, c.doc_id AS docId, bm25(chunks_fts) AS rank
            FROM chunks_fts JOIN chunks c ON c.chunk_id = chunks_fts.rowid
            WHERE chunks_fts MATCH ?${scopeFilter}
            ORDER BY rank LIMIT ?
          `)
          .all(match, ...(scopes ?? []), max) as FtsHit[];
      } catch {
        return [];
      }
    };
    const all = run(words.map(quote).join(" "), limit);
    if (all.length >= limit) return all;
    // A question rarely shares every word with its answer (T-296 eval: natural questions found
    // nothing). Fill up with any-word matches, bm25-ranked so rarer shared words weigh more;
    // one-letter prefixes would match everything and are left out.
    const anyWord = words.filter((word) => word.length > 1);
    if (anyWord.length < 2) return all;
    const seen = new Set(all.map((hit) => hit.chunkId));
    return [
      ...all,
      ...run(anyWord.map(quote).join(" OR "), limit).filter(
        (hit) => !seen.has(hit.chunkId),
      ),
    ].slice(0, limit);
  }

  vecQuery(embedding: Float32Array, limit: number): VecHit[] {
    if (!this.hasVectors) return [];
    const rows = this.db
      .prepare(`
        SELECT v.rowid AS chunkId, c.doc_id AS docId, v.distance AS distance
        FROM chunks_vec v JOIN chunks c ON c.chunk_id = v.rowid
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY v.distance
      `)
      .all(embedding, limit) as Array<{
      chunkId: number;
      docId: number;
      distance: number;
    }>;
    return rows;
  }

  getDoc(docId: number): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM docs WHERE doc_id = ?").get(docId) as
      | Record<string, unknown>
      | undefined;
  }

  getDocByIdOrPath(idOrPath: string): Record<string, unknown> | undefined {
    return this.db
      .prepare("SELECT * FROM docs WHERE id = ? OR path = ?")
      .get(idOrPath, idOrPath) as Record<string, unknown> | undefined;
  }

  getChunk(chunkId: number): Record<string, unknown> | undefined {
    return this.db
      .prepare("SELECT * FROM chunks WHERE chunk_id = ?")
      .get(chunkId) as Record<string, unknown> | undefined;
  }

  linksFor(
    docId: number,
    direction: "out" | "in",
  ): Array<{
    sourceDocId: number;
    targetDocId: number | null;
    targetRaw: string;
  }> {
    const rows = (
      direction === "out"
        ? this.db
            .prepare("SELECT * FROM links WHERE source_doc_id = ?")
            .all(docId)
        : this.db
            .prepare("SELECT * FROM links WHERE target_doc_id = ?")
            .all(docId)
    ) as Array<{
      source_doc_id: number;
      target_doc_id: number | null;
      target_raw: string;
    }>;
    return rows.map((row) => ({
      sourceDocId: row.source_doc_id,
      targetDocId: row.target_doc_id,
      targetRaw: row.target_raw,
    }));
  }

  // Canonical, ordered dump of every row (minus built_at, which changes on every rebuild by
  // design) — used by the round-trip test to prove reindex is deterministic.
  dump(): Record<string, unknown> {
    const meta = this.db
      .prepare(
        "SELECT key, value FROM meta WHERE key != 'built_at' ORDER BY key",
      )
      .all();
    const docs = this.db.prepare("SELECT * FROM docs ORDER BY doc_id").all();
    const chunks = this.db
      .prepare("SELECT * FROM chunks ORDER BY chunk_id")
      .all();
    const links = this.db
      .prepare("SELECT * FROM links ORDER BY source_doc_id, target_raw")
      .all();
    return { meta, docs, chunks, links };
  }

  close(): void {
    this.db.close();
  }
}

export function openIndexReadOnly(file: string): BrainIndexReaderPort {
  return new BrainIndexReader(file);
}

// The concrete brain-index driver, as the BrainIndexPort — wired into application code only
// through composition/runtime.ts.
export const brainIndexPort: BrainIndexPort = { buildIndex, openIndexReadOnly };
