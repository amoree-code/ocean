import type {
  HeadlessResult,
  RuntimeEvent,
} from "../../domain/process/process-events.js";
import type {
  ChatReply,
  ChatRequest,
  ChatToolCall,
  CompletionProvider,
  CompletionRequest,
} from "../../domain/providers/provider.js";
import { redactRuntimeText } from "../../domain/redaction/redaction.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "../process/cli-process.js";

// OpenAI-compatible chat completions over built-in fetch (T-245 Phase 4). Endpoints and
// credential variable names are fixed here, never taken from a profile, so a profile cannot
// send a credential to another host or read another provider's credential. Checked against
// the providers' docs on 2026-10-05 (see the T-245 plan).
export const completionEndpoints: Readonly<Record<CompletionProvider, string>> =
  {
    deepseek: "https://api.deepseek.com/chat/completions",
    openrouter: "https://openrouter.ai/api/v1/chat/completions",
  };

export const completionCredentialEnv: Readonly<
  Record<CompletionProvider, string>
> = {
  deepseek: "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_COMPLETION_TOKENS = 8_192;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8_000;

type CompletionDeps = {
  fetch: typeof fetch;
  endpoints: Readonly<Record<CompletionProvider, string>>;
  env: NodeJS.ProcessEnv;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
};

class CompletionFailure extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Reads at most `maxBytes` of the body; a larger body is cancelled, never buffered whole.
async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new CompletionFailure("Output budget exceeded.", 125);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function retryDelay(response: Response, attempt: number): number {
  const header = Number(response.headers.get("retry-after"));
  const backoff = BACKOFF_BASE_MS * 2 ** (attempt - 1);
  return Math.min(
    BACKOFF_MAX_MS,
    Number.isFinite(header) && header > 0 ? header * 1_000 : backoff,
  );
}

function rateLimit(response: Response): Record<string, string> {
  return Object.fromEntries(
    [...response.headers].filter(
      ([name]) => name.startsWith("x-ratelimit-") || name === "retry-after",
    ),
  );
}

type ChatBody = {
  id?: unknown;
  model?: unknown;
  usage?: unknown;
  choices?: { message?: { content?: unknown; tool_calls?: unknown } }[];
};

const MAX_TOOL_CALLS_PER_REPLY = 16;

function parseToolCalls(value: unknown): ChatToolCall[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_TOOL_CALLS_PER_REPLY)
    throw new CompletionFailure("Malformed completion response: tool_calls", 1);
  return value.map((call) => {
    const { id, function: fn } = (call ?? {}) as {
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    if (
      typeof id !== "string" ||
      typeof fn?.name !== "string" ||
      typeof fn.arguments !== "string"
    )
      throw new CompletionFailure(
        "Malformed completion response: tool_calls",
        1,
      );
    return {
      id,
      type: "function" as const,
      function: { name: fn.name, arguments: fn.arguments },
    };
  });
}

function parseReply(source: string, fallbackModel: string): ChatReply {
  let body: ChatBody;
  try {
    body = JSON.parse(source) as ChatBody;
  } catch {
    throw new CompletionFailure("Malformed completion response: not JSON", 1);
  }
  const message = body?.choices?.[0]?.message;
  const toolCalls = parseToolCalls(message?.tool_calls);
  const content = message?.content ?? null;
  if (typeof content !== "string" && !(content === null && toolCalls?.length))
    throw new CompletionFailure(
      "Malformed completion response: no choices[0].message.content",
      1,
    );
  return {
    message: {
      role: "assistant",
      content,
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
    },
    model: typeof body.model === "string" ? body.model : fallbackModel,
    usage: body.usage ?? null,
    id: typeof body.id === "string" ? body.id : null,
  };
}

// One chat turn: credential check, request, bounded read, transient retries. Throws a
// CompletionFailure (with its exit code) on anything else.
async function chat(
  request: Omit<ChatRequest, "signal" | "onEvent">,
  deps: CompletionDeps,
  emit: (event: RuntimeEvent) => void,
  signal: AbortSignal,
): Promise<ChatReply & { meta: Record<string, unknown> }> {
  const endpoint = deps.endpoints[request.provider];
  const credentialName = completionCredentialEnv[request.provider];
  if (!endpoint)
    throw new CompletionFailure(
      `Unsupported completion provider: ${request.provider}`,
      1,
    );
  // Fails before any request is made; names the variable, never its value.
  const credential = deps.env[credentialName];
  if (!credential)
    throw new CompletionFailure(
      `Missing credential: set ${credentialName} in the environment`,
      1,
    );
  const maxBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const attempts = Math.max(1, request.maxAttempts ?? 1);
  for (let attempt = 1; ; attempt += 1) {
    const response = await deps.fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        max_tokens: MAX_COMPLETION_TOKENS,
        stream: false,
        ...(request.temperature === undefined
          ? {}
          : { temperature: request.temperature }),
        ...(request.tools.length ? { tools: request.tools } : {}),
      }),
      // A redirect could carry the credential to another host; it is an error instead.
      redirect: "error",
      signal,
    });
    const meta = {
      provider: request.provider,
      status: response.status,
      requestId: response.headers.get("x-request-id"),
      rateLimit: rateLimit(response),
      attempt,
    };
    if (response.ok)
      return {
        ...parseReply(await readBounded(response, maxBytes), request.model),
        meta,
      };
    // Only 429 and 5xx are transient. Authentication, validation and policy failures are
    // never retried.
    const transient = response.status === 429 || response.status >= 500;
    // An upstream error body is untrusted: it could echo the request back, so the credential
    // is removed before it reaches stderr or the session.
    const detail = redactRuntimeText(
      (await readBounded(response, 4_096).catch(() => ""))
        .split(credential)
        .join("[REDACTED]")
        .slice(0, 500),
    );
    if (!transient || attempt >= attempts) {
      await response.body?.cancel().catch(() => undefined);
      throw new CompletionFailure(
        `Completion request failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`,
        1,
      );
    }
    const delayMs = retryDelay(response, attempt);
    emit({
      type: "json",
      data: { type: "completion_retry", ...meta, delayMs },
    });
    await deps.sleep(delayMs, signal);
  }
}

async function complete(
  request: CompletionRequest,
  deps: CompletionDeps,
  emit: (event: RuntimeEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const started = Date.now();
  const reply = await chat(
    {
      provider: request.provider,
      model: request.model,
      temperature: request.temperature,
      messages: [{ role: "user", content: request.prompt }],
      tools: [],
      maxOutputBytes: request.maxOutputBytes,
      maxAttempts: request.maxAttempts,
    },
    deps,
    emit,
    signal,
  );
  if (typeof reply.message.content !== "string")
    throw new CompletionFailure(
      "Malformed completion response: no choices[0].message.content",
      1,
    );
  emit({
    type: "json",
    data: {
      type: "completion",
      ...reply.meta,
      id: reply.id,
      model: reply.model,
      usage: reply.usage,
      durationMs: Date.now() - started,
      text: reply.message.content,
    },
  });
}

function defaultDeps(overrides: Partial<CompletionDeps>): CompletionDeps {
  return {
    // Resolved per call, so a fetch installed after import is the one used.
    fetch: (...args) => globalThis.fetch(...args),
    endpoints: completionEndpoints,
    env: process.env,
    sleep: abortableSleep,
    ...overrides,
  };
}

// The tool loop's transport: one turn per call, under the caller's signal. A failure is
// thrown with an `exitCode` (124 when the caller's deadline aborted it).
export function createChatTransport(
  overrides: Partial<CompletionDeps> = {},
): (request: ChatRequest) => Promise<ChatReply> {
  const deps = defaultDeps(overrides);
  return async ({ signal, onEvent, ...request }) => {
    try {
      const { meta: _meta, ...reply } = await chat(
        request,
        deps,
        (event) => onEvent?.(event),
        signal,
      );
      return reply;
    } catch (error) {
      if (error instanceof CompletionFailure) throw error;
      if (signal.aborted) throw signal.reason;
      throw new CompletionFailure(
        `Completion request failed: ${(error as Error).message}`,
        1,
      );
    }
  };
}

export const chatTransport = createChatTransport();

export function createCompletionExecutor(
  overrides: Partial<CompletionDeps> = {},
): (request: CompletionRequest) => Promise<HeadlessResult> {
  const deps = defaultDeps(overrides);
  return async (request) => {
    const events: RuntimeEvent[] = [];
    const emit = (event: RuntimeEvent) => {
      events.push(event);
      request.onEvent?.(event);
    };
    // One deadline covers every attempt and every backoff.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new CompletionFailure("Process timed out.", 124)),
      request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      await complete(request, deps, emit, controller.signal);
      return { exitCode: 0, events, stderr: "" };
    } catch (error) {
      const failure =
        error instanceof CompletionFailure
          ? error
          : controller.signal.aborted &&
              controller.signal.reason instanceof CompletionFailure
            ? controller.signal.reason
            : new CompletionFailure(
                `Completion request failed: ${(error as Error).message}`,
                1,
              );
      return {
        exitCode: failure.exitCode,
        events,
        stderr: `${failure.message}\n`,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

export const runCompletion = createCompletionExecutor();
