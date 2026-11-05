import { z } from "zod";

const evidenceResultSchema = z.enum(["proven", "not_proven", "limitation"]);
export const evidenceSchema = z.object({
  evidenceId: z.string().min(1),
  sessionId: z.string().min(1),
  type: z.string().min(1),
  source: z.string().min(1),
  observedAt: z.string().datetime(),
  result: evidenceResultSchema,
  criterion: z.string().min(1).nullable(),
  payload: z.string().max(64_000),
});
export type EvidenceRecord = z.infer<typeof evidenceSchema>;
export function validateEvidence(input: unknown): EvidenceRecord {
  return evidenceSchema.parse(input);
}
