import { spawn } from "node:child_process";
import {
  evaluateGuard,
  type GuardDecision,
  type GuardRequest,
} from "../../application/operations/write-guard.js";
import { redactRuntimeText } from "../observability/runtime-logger.js";
import { resolveOriginalExecutable } from "./provider-registry.js";

// Provider-neutral headless invocation boundary (T-198 slice 10). One contract for every
// supported provider: guard first, then a non-interactive spawn with stdin closed and a hard
// timeout, then a structured result — never a thrown error, never an interactive prompt.
//
// The per-provider flags below were verified live against the installed binaries. Note what
// is deliberately NOT here: no --dangerously-skip-permissions (claude), no --full-auto or
// --dangerously-bypass-approvals-and-sandbox (codex), no --yolo (gemini). Ocean approval is
// the Ocean guard's job; an auto-approve flag is never used as a substitute for it. The
// flags that are present only disable the provider's *interactive directory-trust prompt*,
// which is required for any headless run at all.
export type ProviderParseMode = "json" | "text";

export type ProviderHeadlessSpec = {
  args: (prompt: string) => string[];
  parse: ProviderParseMode;
};

export const PROVIDER_HEADLESS: Record<string, ProviderHeadlessSpec> = {
  claude: {
    args: (prompt) => ["-p", prompt, "--output-format", "json"],
    parse: "json",
  },
  codex: {
    args: (prompt) => ["exec", prompt, "--skip-git-repo-check"],
    parse: "text",
  },
  gemini: { args: (prompt) => ["-p", prompt, "--skip-trust"], parse: "text" },
};

export type ProviderSupport =
  | { supported: true; spec: ProviderHeadlessSpec }
  | { supported: false; reason: string };

export function providerHeadlessSupport(provider: string): ProviderSupport {
  const spec = PROVIDER_HEADLESS[provider];
  if (!spec)
    return {
      supported: false,
      reason: `provider '${provider}' has no verified headless contract in Ocean — it stays gated as unsupported`,
    };
  return { supported: true, spec };
}

type ProviderStatus =
  | "completed"
  | "failed"
  | "timeout"
  | "unsupported"
  | "unavailable"
  | "denied";

export type ProviderResult = {
  provider: string;
  status: ProviderStatus;
  exitCode: number | null;
  durationMs: number;
  providerSessionId: string | null;
  oceanSessionId: string;
  parentSessionId: string | null;
  malformedLines: number;
  partial: boolean;
  output: string;
  reason: string;
  guard: GuardDecision | null;
};

const MAX_OUTPUT_CHARS = 4_000;

export type ParsedStream = {
  events: Record<string, unknown>[];
  malformedLines: number;
  partial: boolean;
  providerSessionId: string | null;
};

function sessionIdOf(event: Record<string, unknown>): string | null {
  for (const key of ["session_id", "sessionId"]) {
    const value = event[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const nested = event.session;
  if (nested && typeof nested === "object") {
    const value = (nested as Record<string, unknown>).id;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

// Tolerant, deterministic stream parsing: a malformed line is counted, never thrown, and an
// unterminated trailing line is reported as partial rather than silently dropped.
export function parseProviderStream(
  text: string,
  mode: ProviderParseMode = "json",
): ParsedStream {
  if (mode === "text")
    return {
      events: [],
      malformedLines: 0,
      partial: false,
      providerSessionId: null,
    };
  const trimmed = text.trim();
  if (trimmed.length === 0)
    return {
      events: [],
      malformedLines: 0,
      partial: false,
      providerSessionId: null,
    };

  try {
    const single = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      events: [single],
      malformedLines: 0,
      partial: false,
      providerSessionId: sessionIdOf(single),
    };
  } catch {
    // Fall through to line-by-line parsing.
  }

  const endsCleanly = text.endsWith("\n");
  const lines = text.split("\n");
  const events: Record<string, unknown>[] = [];
  let malformedLines = 0;
  let partial = false;
  let providerSessionId: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const isLast = index === lines.length - 1;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      events.push(event);
      providerSessionId = providerSessionId ?? sessionIdOf(event);
    } catch {
      if (isLast && !endsCleanly) partial = true;
      else malformedLines += 1;
    }
  }
  return { events, malformedLines, partial, providerSessionId };
}

export type ProviderInvocationRequest = {
  provider: string;
  prompt: string;
  oceanSessionId: string;
  parentSessionId?: string | null;
  cwd: string;
  timeoutMs?: number;
  guard: GuardRequest;
  executable?: string;
};

function result(
  request: ProviderInvocationRequest,
  status: ProviderStatus,
  reason: string,
  overrides: Partial<ProviderResult> = {},
): ProviderResult {
  return {
    provider: request.provider,
    status,
    exitCode: null,
    durationMs: 0,
    providerSessionId: null,
    oceanSessionId: request.oceanSessionId,
    parentSessionId: request.parentSessionId ?? null,
    malformedLines: 0,
    partial: false,
    output: "",
    reason,
    guard: null,
    ...overrides,
  };
}

// Every external provider action goes through here, and the guard runs before the process is
// ever spawned. A denial returns a structured result; it never reaches spawn().
export async function invokeProviderHeadless(
  request: ProviderInvocationRequest,
): Promise<ProviderResult> {
  const support = providerHeadlessSupport(request.provider);
  if (!support.supported) return result(request, "unsupported", support.reason);

  const decision = evaluateGuard(request.guard);
  if (!decision.allowed) {
    return result(
      request,
      "denied",
      `provider invocation denied by the Ocean write guard: ${decision.reason}`,
      { guard: decision },
    );
  }

  let executable: string;
  try {
    executable =
      request.executable ?? resolveOriginalExecutable(request.provider);
  } catch (error) {
    return result(
      request,
      "unavailable",
      `provider '${request.provider}' is not available on this machine: ${error instanceof Error ? error.message : String(error)}`,
      { guard: decision },
    );
  }

  const started = Date.now();
  const timeoutMs = request.timeoutMs ?? 120_000;
  return await new Promise<ProviderResult>((resolve) => {
    const child = spawn(executable, support.spec.args(request.prompt), {
      cwd: request.cwd,
      // stdin is closed: a headless invocation must never depend on an interactive prompt.
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve(
        result(
          request,
          "timeout",
          `provider '${request.provider}' exceeded the ${timeoutMs}ms budget and was terminated`,
          {
            durationMs: Date.now() - started,
            guard: decision,
            output: redactRuntimeText(stdout).slice(0, MAX_OUTPUT_CHARS),
          },
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const finish = (exitCode: number | null, failureReason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const parsed = parseProviderStream(stdout, support.spec.parse);
      const ok = exitCode === 0 && !failureReason;
      resolve(
        result(
          request,
          ok ? "completed" : "failed",
          failureReason ??
            (ok
              ? `provider '${request.provider}' completed`
              : `provider '${request.provider}' exited with code ${exitCode}`),
          {
            exitCode,
            durationMs: Date.now() - started,
            providerSessionId: parsed.providerSessionId,
            malformedLines: parsed.malformedLines,
            partial: parsed.partial,
            // Output is redacted and clipped: provider stdout/stderr never lands in a result raw.
            output: redactRuntimeText(stdout || stderr).slice(
              0,
              MAX_OUTPUT_CHARS,
            ),
            guard: decision,
          },
        ),
      );
    };

    child.on("error", (error) =>
      finish(
        null,
        `provider '${request.provider}' could not be executed: ${error.message}`,
      ),
    );
    child.on("close", (code) => finish(code));
  });
}
