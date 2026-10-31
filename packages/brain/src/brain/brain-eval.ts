import type { BrainIndexPort } from "@ocean/core/domain/ports/brain-index-port.js";
import type { EmbedderPort } from "@ocean/core/domain/ports/embedder-port.js";
import { brainSearch } from "./brain-service.js";

// Retrieval eval (T-296 §3.10): recall@k over questions whose answer record is known. The kernel
// tests run a synthetic set; the owner keeps a private set in the workspace and runs
// `ocean memory eval <file>`. A case is a hit when any expected path — store path
// ("memory/x.md") or workspace file ("02-personal/x.md") — is among the top k results.

export type EvalCase = {
  question: string;
  expect: string | string[];
  // Bound project for a scoped search; omitted = unscoped.
  project?: string | null;
};

export type EvalResult = {
  k: number;
  total: number;
  hits: number;
  recall: number;
  misses: { question: string; expect: string[]; got: string[] }[];
};

export async function evaluateRecall(
  cases: EvalCase[],
  options: {
    indexPort: BrainIndexPort;
    root?: string;
    embedder?: EmbedderPort | null;
    k?: number;
  },
): Promise<EvalResult> {
  const k = options.k ?? 5;
  const misses: EvalResult["misses"] = [];
  for (const item of cases) {
    const expect = [item.expect].flat();
    const { results } = await brainSearch({
      query: item.question,
      limit: k,
      root: options.root,
      embedder: options.embedder ?? null,
      indexPort: options.indexPort,
      scope: item.project === undefined ? undefined : { project: item.project },
    });
    const got = results.map((hit) => hit.file);
    const found = results.some(
      (hit) => expect.includes(hit.path) || expect.includes(hit.file),
    );
    if (!found) misses.push({ question: item.question, expect, got });
  }
  const hits = cases.length - misses.length;
  return {
    k,
    total: cases.length,
    hits,
    recall: cases.length ? hits / cases.length : 0,
    misses,
  };
}
