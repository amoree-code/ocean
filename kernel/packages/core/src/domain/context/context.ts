import { z } from "zod";

// A file the prompt points at instead of inlining. `path` is always relative: to the run cwd
// for a profile contextSources entry, to the Ocean root for a context-packet record.
export const contextReferenceSchema = z.object({
  path: z.string().min(1),
  base: z.enum(["cwd", "ocean-root"]),
  recordType: z.string().min(1),
  reason: z.string().min(1),
  bytes: z.number().int().nonnegative().nullable(),
});

export type ContextReference = z.infer<typeof contextReferenceSchema>;

export const contextManifestSchema = z.object({
  files: z.array(z.string()),
  bytes: z.number().int().nonnegative(),
  compactedSummary: z.string().nullable(),
  lastContextCheckpoint: z.string().min(1),
  maxBytes: z.number().int().positive().default(32_000),
  omitted: z.array(z.string()).default([]),
  compression: z
    .object({
      sourceId: z.string().min(1),
      sourceHash: z.string().min(1),
      originalBytes: z.number().int().nonnegative(),
      compressedBytes: z.number().int().nonnegative(),
      method: z.string().min(1),
      budget: z.number().int().positive(),
      omittedSections: z.array(z.string()),
      recoveryRef: z.string().min(1),
      safeToUse: z.boolean(),
    })
    .nullable()
    .default(null),
  references: z.array(contextReferenceSchema).default([]),
});

export type ContextManifest = z.infer<typeof contextManifestSchema>;
