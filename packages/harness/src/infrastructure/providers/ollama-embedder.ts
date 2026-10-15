import type { EmbedderPort } from "@ocean/core/domain/ports/embedder-port.js";
import { oceanEnv } from "../../paths.js";

// Local-only embedder for the brain index (T-228). Talks to a local Ollama daemon over
// loopback only — never a remote host, never a `:cloud` model (Ollama's proxy to
// ollama.com). This is a hard privacy boundary, not a convenience default: brain/02-personal
// and brain/05-knowledge content must never leave the machine to be embedded.

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export class RemoteEmbedderRefusedError extends Error {}

function assertLoopback(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new RemoteEmbedderRefusedError(
      `OCEAN_OLLAMA_URL is not a valid URL: ${rawUrl}`,
    );
  }
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw new RemoteEmbedderRefusedError(
      `refusing non-loopback embedder host '${url.hostname}' — only 127.0.0.1/localhost/::1 are allowed`,
    );
  }
  return url;
}

function assertNotCloudModel(model: string): void {
  if (model.toLowerCase().includes("cloud")) {
    throw new RemoteEmbedderRefusedError(
      `refusing ':cloud'-style model '${model}' — it proxies to a remote host`,
    );
  }
}

type EmbedResponse = { embeddings: number[][] };
type ShowResponse = { remote_host?: string; remote_model?: string };

const DEFAULT_BATCH_SIZE = 32;

export type OllamaEmbedderOptions = {
  baseUrl?: string;
  model?: string;
  batchSize?: number;
  fetchImpl?: typeof fetch;
};

// Creates and validates an embedder against the live Ollama daemon: confirms loopback host,
// confirms the model name and `/api/show` report neither name a remote model, and probes
// dimensions with a single embed call. Throws (does not silently fall back) on any refusal —
// reindex is expected to fail loudly unless the caller explicitly passed --no-vectors.
export async function createOllamaEmbedder(
  options: OllamaEmbedderOptions = {},
): Promise<EmbedderPort> {
  const baseUrl =
    options.baseUrl ?? oceanEnv("OLLAMA_URL") ?? "http://127.0.0.1:11434";
  const model = options.model ?? oceanEnv("EMBED_MODEL") ?? "embeddinggemma";
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const doFetch = options.fetchImpl ?? fetch;

  const url = assertLoopback(baseUrl);
  assertNotCloudModel(model);

  const showResponse = await doFetch(new URL("/api/show", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
  });
  if (showResponse.ok) {
    const show = (await showResponse.json()) as ShowResponse;
    if (show.remote_host || show.remote_model) {
      throw new RemoteEmbedderRefusedError(
        `refusing model '${model}' — Ollama reports it as remote (${show.remote_host ?? show.remote_model})`,
      );
    }
  }

  const embed = async (texts: string[]): Promise<Float32Array[]> => {
    const out: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += batchSize) {
      const batch = texts.slice(start, start + batchSize);
      const response = await doFetch(new URL("/api/embed", url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: batch }),
      });
      if (!response.ok) {
        throw new Error(
          `Ollama /api/embed failed with status ${response.status}: ${await response.text()}`,
        );
      }
      const body = (await response.json()) as EmbedResponse;
      for (const embedding of body.embeddings)
        out.push(new Float32Array(embedding));
    }
    return out;
  };

  const probe = await embed(["dimension probe"]);
  const dimensions = probe[0]?.length ?? 0;
  if (dimensions <= 0)
    throw new Error(`Ollama returned an empty embedding for model '${model}'`);

  return { model, dimensions, embed };
}
