import { z } from "zod";

// Canonical brain-record schema (T-228): the frontmatter shape every markdown record under
// brain/02-personal and brain/05-knowledge normalizes into. Types + zod only, no I/O — the
// markdown layer (application/brain/brain-markdown.ts) is what actually reads legacy
// frontmatter and maps it onto this shape.

export const brainRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().default(""),
  tags: z.array(z.string()).default([]),
  type: z.string().default("unknown"),
  confidence: z.string().default("unknown"),
  created: z.string().nullable().default(null),
  updated: z.string().nullable().default(null),
  lastConfirmedAt: z.string().nullable().default(null),
  // Normalized by domain/brain/record-scope.ts: "global", "project:<id>" or "invalid".
  scope: z.string().default("global"),
});

export type BrainRecord = z.infer<typeof brainRecordSchema>;

export function validateBrainRecord(input: unknown): BrainRecord {
  return brainRecordSchema.parse(input);
}

// Per-field provenance: whether a field's value was declared under its canonical key,
// recovered through a legacy alias (e.g. `last_verified` -> lastConfirmedAt), or defaulted
// because nothing in the frontmatter supplied it. Surfaced in reindex's conformance report
// so a migration decision can be made without guessing which files still use legacy keys.
export type FieldConformance = "declared" | "aliased" | "defaulted";

export type BrainConformance = Record<keyof BrainRecord, FieldConformance>;
