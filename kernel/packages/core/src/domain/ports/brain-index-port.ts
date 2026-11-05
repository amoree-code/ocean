import type { BrainConformance } from "../brain/brain-record.js";

// Port for the brain (T-228) index driver. application/brain/* depends only on this — the
// concrete node:sqlite + sqlite-vec implementation lives in infrastructure/brain/brain-index.ts
// and is wired in through composition/runtime.js, never imported directly by application
// code (enforced by tests/architecture.test.mjs).

// 2: docs carry a scope. The index is a disposable cache, so a bump means "reindex", not a migration.
export const BRAIN_INDEX_SCHEMA_VERSION = "2";

export type EmbedderPort = {
  model: string;
  dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
};

export type IndexChunkInput = {
  ordinal: number;
  heading: string | null;
  text: string;
  normalizedText: string;
};

export type IndexDocInput = {
  id: string;
  path: string;
  title: string;
  summary: string;
  tags: string[];
  type: string;
  // "global" | "project:<id>" | "invalid" (domain/brain/record-scope.ts).
  scope: string;
  confidence: string;
  created: string | null;
  updated: string | null;
  lastConfirmedAt: string | null;
  contentHash: string;
  bytes: number;
  conformance: BrainConformance;
  chunks: IndexChunkInput[];
};

export type IndexLinkInput = {
  sourcePath: string;
  targetRaw: string;
  targetPath: string | null;
};

export type BuildIndexOptions = {
  corpusHash: string;
  embedder: EmbedderPort | null;
};

export type IndexMeta = {
  schemaVersion: string;
  embedder: string;
  dims: number;
  corpusHash: string;
  builtAt: string;
};

export type FtsHit = { chunkId: number; docId: number; rank: number };
export type VecHit = { chunkId: number; docId: number; distance: number };

export interface BrainIndexReaderPort {
  readonly meta: IndexMeta;
  readonly hasVectors: boolean;
  ftsQuery(normalizedQuery: string, limit: number, scopes?: string[]): FtsHit[];
  vecQuery(embedding: Float32Array, limit: number): VecHit[];
  getDoc(docId: number): Record<string, unknown> | undefined;
  getDocByIdOrPath(idOrPath: string): Record<string, unknown> | undefined;
  getChunk(chunkId: number): Record<string, unknown> | undefined;
  linksFor(
    docId: number,
    direction: "out" | "in",
  ): Array<{
    sourceDocId: number;
    targetDocId: number | null;
    targetRaw: string;
  }>;
  dump(): Record<string, unknown>;
  close(): void;
}

export type BrainIndexPort = {
  buildIndex(
    docs: IndexDocInput[],
    links: IndexLinkInput[],
    outFile: string,
    options: BuildIndexOptions,
  ): Promise<void>;
  openIndexReadOnly(file: string): BrainIndexReaderPort;
};
