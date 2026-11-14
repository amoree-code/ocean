import { mkdir } from "node:fs/promises";
import type { CompleteText } from "@ocean/brain/memory/session-facts.js";
import type { RuntimeEvent } from "@ocean/core/domain/process/process-events.js";
import type { HeadlessProvider } from "@ocean/core/domain/providers/provider.js";
import {
  oceanEnv,
  oceanEnvPair,
  oceanPath,
  SYSTEM_DIR,
} from "@ocean/core/shared/paths.js";
import type { SessionEndClient } from "@ocean/loop/hooks/session-end-hook.js";
import { resolveOriginalExecutable } from "./provider-registry.js";
import { runProvider } from "./providers.js";

// The model call behind session fact capture (T-313), through the provider layer: the client
// whose session it was runs it, so whoever uses only Codex gets capture too and no other CLI is
// required. Read-only, in a folder of its own (no project context to load), with a cheap model
// where the client has a known one. OCEAN_SESSION_FACTS_MODEL overrides it.

// The env flag the spawned call carries: its own hooks see it and do nothing, so the capture
// call is never recorded as a session, and never captures from itself.
export const FACTS_CALL_ENV = "FACTS_CALL";

const DEFAULT_MODEL: Partial<Record<HeadlessProvider, string>> = {
  claude: "haiku",
};

const PROVIDER: Partial<Record<SessionEndClient, HeadlessProvider>> = {
  claude: "claude",
  codex: "codex",
};

const TIMEOUT_MS = 90_000;

// The model's final answer: the Claude SDK's `result` message, or Codex's last agent message
// (`codex exec --json`); otherwise the plain text the client printed.
export function finalText(events: RuntimeEvent[]): string | null {
  let answer: string | null = null;
  const texts: string[] = [];
  for (const event of events) {
    if (event.type === "text") {
      if (typeof event.data === "string") texts.push(event.data);
      continue;
    }
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object") continue;
    if (data.type === "result" && typeof data.result === "string")
      answer = data.result;
    const item = data.item as Record<string, unknown> | undefined;
    if (
      data.type === "item.completed" &&
      item?.type === "agent_message" &&
      typeof item.text === "string"
    )
      answer = item.text;
  }
  return answer ?? (texts.length ? texts.join("\n") : null);
}

export function sessionFactsCompleter(
  client: SessionEndClient,
  run: typeof runProvider = runProvider,
): CompleteText | null {
  const provider = PROVIDER[client];
  if (!provider) return null;
  try {
    resolveOriginalExecutable(provider);
  } catch {
    return null;
  }
  const model = oceanEnv("SESSION_FACTS_MODEL") ?? DEFAULT_MODEL[provider];
  return async (prompt) => {
    const cwd = oceanPath(SYSTEM_DIR, "state", "memory", "extract");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const result = await run({
      provider,
      prompt,
      cwd,
      readOnly: true,
      model,
      timeoutMs: TIMEOUT_MS,
      env: oceanEnvPair(FACTS_CALL_ENV, "1"),
    });
    return result.exitCode === 0 ? finalText(result.events) : null;
  };
}
