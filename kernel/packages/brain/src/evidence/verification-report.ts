import { createHash } from "node:crypto";
import {
  type EvidenceRecord,
  evidenceSchema,
} from "@ocean/core/domain/evidence/evidence.js";

export type VerificationReport = {
  proven: EvidenceRecord[];
  notProven: EvidenceRecord[];
  limitations: EvidenceRecord[];
  fingerprint: string;
};
export function buildVerificationReport(
  records: EvidenceRecord[],
): VerificationReport {
  const evidence = records.map((record) => evidenceSchema.parse(record));
  const proven = evidence.filter((record) => record.result === "proven");
  const notProven = evidence.filter((record) => record.result === "not_proven");
  const limitations = evidence.filter(
    (record) => record.result === "limitation",
  );
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ proven, notProven, limitations }))
    .digest("hex");
  return { proven, notProven, limitations, fingerprint };
}
