import type { HeadlessProvider } from "@ocean/core/domain/providers/provider.js";
import { oceanEnv, oceanEnvPair, oceanRoot } from "@ocean/core/shared/paths.js";
import type { TaskReviewer } from "@ocean/loop/tasks/task-verification.js";
import { resolveOriginalExecutable } from "./provider-registry.js";
import { runProvider } from "./providers.js";
import { FACTS_CALL_ENV, finalText } from "./session-facts-completer.js";

// The optional independent review of `ocean tasks verify` (T-320 F2): read-only, on the
// cheapest model, run only for a task that sets `review: agent`. It reads the workspace (to
// check that cited files exist) and never writes. OCEAN_TASK_REVIEW_MODEL overrides the model.

const PROVIDER: HeadlessProvider = "claude";
const DEFAULT_MODEL = "haiku";
const TIMEOUT_MS = 180_000;

const REVIEW_SYSTEM_PROMPT =
  "You are a strict, read-only verifier. You never edit files or run commands that change state. You check that claims point to evidence and finish with one verdict line.";

export function taskReviewer(
  run: typeof runProvider = runProvider,
): TaskReviewer | null {
  try {
    resolveOriginalExecutable(PROVIDER);
  } catch {
    return null;
  }
  const model = oceanEnv("TASK_REVIEW_MODEL") ?? DEFAULT_MODEL;
  return async (prompt) => {
    const result = await run({
      provider: PROVIDER,
      prompt,
      cwd: oceanRoot(),
      readOnly: true,
      bare: { systemPrompt: REVIEW_SYSTEM_PROMPT },
      model,
      timeoutMs: TIMEOUT_MS,
      // The same flag the fact-capture call carries: its hooks see it and record no session.
      env: oceanEnvPair(FACTS_CALL_ENV, "1"),
    });
    return result.exitCode === 0 ? finalText(result.events) : null;
  };
}
