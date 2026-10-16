import { createHash } from "node:crypto";

export type CompressionResult = {
  content: string;
  sourceId: string;
  sourceHash: string;
  originalBytes: number;
  compressedBytes: number;
  method: "none" | "ocean-bounded-v1" | "fallback-original-bounded";
  budget: number;
  omittedSections: string[];
  recoveryRef: string;
  safeToUse: boolean;
};

const REQUIRED =
  /changed files?|verification|security|approval|error|failed|next action/i;

function boundedByBytes(value: string, budget: number): string {
  return Buffer.from(value).subarray(0, budget).toString("utf8");
}

function unique(lines: string[]): string[] {
  return [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
}

export function compressContext(input: {
  sourceId: string;
  content: string;
  budget: number;
}): CompressionResult {
  const originalBytes = Buffer.byteLength(input.content);
  const sourceHash = createHash("sha256").update(input.content).digest("hex");
  if (input.budget <= 0) throw new Error("Compression budget must be positive");
  if (originalBytes <= input.budget) {
    return {
      content: input.content,
      sourceId: input.sourceId,
      sourceHash,
      originalBytes,
      compressedBytes: originalBytes,
      method: "none",
      budget: input.budget,
      omittedSections: [],
      recoveryRef: input.sourceId,
      safeToUse: true,
    };
  }

  const lines = input.content.split(/\r?\n/);
  const required = unique(lines.filter((line) => REQUIRED.test(line)));
  const selected = unique([lines[0] ?? "", ...required, lines.at(-1) ?? ""]);
  const content = selected.join("\n");
  const compressedBytes = Buffer.byteLength(content);
  const omittedSections = lines
    .filter((line) => line.trim() && !selected.includes(line.trim()))
    .slice(0, 20)
    .map((line) => line.trim().slice(0, 120));
  if (
    compressedBytes <= input.budget &&
    required.every((line) => content.includes(line.trim()))
  ) {
    return {
      content,
      sourceId: input.sourceId,
      sourceHash,
      originalBytes,
      compressedBytes,
      method: "ocean-bounded-v1",
      budget: input.budget,
      omittedSections,
      recoveryRef: input.sourceId,
      safeToUse: true,
    };
  }

  const fallback = boundedByBytes(input.content, input.budget);
  return {
    content: fallback,
    sourceId: input.sourceId,
    sourceHash,
    originalBytes,
    compressedBytes: Buffer.byteLength(fallback),
    method: "fallback-original-bounded",
    budget: input.budget,
    omittedSections,
    recoveryRef: input.sourceId,
    safeToUse: false,
  };
}
