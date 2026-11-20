import type { BrainIndexPort } from "@ocean/core/domain/ports/brain-index-port.js";
import type { EmbedderPort } from "@ocean/core/domain/ports/embedder-port.js";
import { brainSearch } from "./brain-service.js";

// Retrieval eval (T-296 §3.10, T-321): hit@1, hit@k and MRR over questions whose answer record
// is known. The kernel tests run a synthetic set; the owner keeps a private set in the workspace
// and runs `ocean memory eval <file>`. A case is a hit when any expected path — store path
// ("memory/x.md") or workspace file ("02-personal/x.md") — is among the top k results.

export type EvalCase = {
  question: string;
  expect: string | string[];
  // Bound project for a scoped search; omitted = unscoped.
  project?: string | null;
};

export type EvalResult = {
  // The settings the numbers were produced with, so two runs are only compared like for like.
  settings: {
    mode: "hybrid" | "fts";
    embedder: string | null;
    k: number;
    depth: number;
  };
  k: number;
  total: number;
  hits: number;
  // hit@k; kept under its T-296 name.
  recall: number;
  hitAt1: number;
  mrr: number;
  misses: { question: string; expect: string[]; got: string[] }[];
};

// MRR looks past k so a near miss at rank 6–10 still counts for something.
const MRR_DEPTH = 10;

// A JSON array, or JSON Lines (one case per line, blank lines ignored).
export function parseEvalCases(text: string): EvalCase[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) return JSON.parse(trimmed) as EvalCase[];
  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvalCase);
}

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
  const depth = Math.max(k, MRR_DEPTH);
  const misses: EvalResult["misses"] = [];
  let hitsAt1 = 0;
  let reciprocalSum = 0;
  let hybrid = cases.length > 0;
  for (const item of cases) {
    const expect = [item.expect].flat();
    const { results, mode } = await brainSearch({
      query: item.question,
      limit: depth,
      root: options.root,
      embedder: options.embedder ?? null,
      indexPort: options.indexPort,
      scope: item.project === undefined ? undefined : { project: item.project },
    });
    if (mode !== "hybrid") hybrid = false;
    const rank =
      results.findIndex(
        (hit) => expect.includes(hit.path) || expect.includes(hit.file),
      ) + 1;
    if (rank === 1) hitsAt1 += 1;
    if (rank > 0) reciprocalSum += 1 / rank;
    if (rank === 0 || rank > k)
      misses.push({
        question: item.question,
        expect,
        got: results.slice(0, k).map((hit) => hit.file),
      });
  }
  const total = cases.length;
  const hits = total - misses.length;
  const ratio = (value: number) =>
    total ? Math.round((value / total) * 1000) / 1000 : 0;
  return {
    settings: {
      mode: hybrid ? "hybrid" : "fts",
      embedder: hybrid ? (options.embedder?.model ?? null) : null,
      k,
      depth,
    },
    k,
    total,
    hits,
    recall: ratio(hits),
    hitAt1: ratio(hitsAt1),
    mrr: ratio(reciprocalSum),
    misses,
  };
}
