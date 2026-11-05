// Deterministic test-double embedder: a 64-dim hashed bag-of-normalized-tokens vector, with
// no model download and no network call. Not a real embedding model — good enough to
// exercise the vec0 path (insert, KNN query, RRF fusion) deterministically in tests.

const DIMS = 64;

function hashToken(token) {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function embedOne(text) {
  const vector = new Float32Array(DIMS);
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  for (const token of tokens) {
    const bucket = hashToken(token) % DIMS;
    vector[bucket] += 1;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIMS; i += 1) vector[i] /= norm;
  return vector;
}

export function createFakeEmbedder() {
  return {
    model: "fake-test-embedder",
    dimensions: DIMS,
    async embed(texts) {
      return texts.map(embedOne);
    },
  };
}
