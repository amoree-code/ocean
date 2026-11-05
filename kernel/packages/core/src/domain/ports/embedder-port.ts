// Port for the local embedding model used by the brain index (T-228). Domain-only contract
// — the concrete implementation (infrastructure/providers/ollama-embedder.ts) talks to
// Ollama over loopback; nothing in application/ or domain/ knows that detail.
export type EmbedderPort = {
  model: string;
  dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
};
