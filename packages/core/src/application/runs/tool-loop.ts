import type {
  AgentToolPort,
  ChatPort,
} from "../../domain/ports/runtime-ports.js";
import type {
  HeadlessResult,
  RuntimeEvent,
} from "../../domain/process/process-events.js";
import type {
  ChatMessage,
  CompletionProvider,
} from "../../domain/providers/provider.js";
import { redactRuntimeText } from "../../domain/redaction/redaction.js";
import {
  decideToolCall,
  toolDefinitions,
} from "../../domain/runs/agent-tools.js";
import type { ExecutionPlan } from "../../domain/runs/execution-plan.js";

// A completion client working through Ocean's tools, bounded on every axis (T-245 Phase 6):
// iterations, tool calls, one wall-clock deadline, total tool output, repeated calls, and
// cancellation. Every tool call is decided against the execution plan before it runs.

export const MAX_ITERATIONS = 20;
export const MAX_TOOL_CALLS = 50;
export const MAX_REPEATS = 3;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export type ToolLoopRequest = {
  plan: ExecutionPlan;
  prompt: string;
  chat: ChatPort;
  executeTool: AgentToolPort;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
  onEvent?: (event: RuntimeEvent) => void;
};

class LoopStop extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

export async function runToolLoop(
  request: ToolLoopRequest,
): Promise<HeadlessResult> {
  const { plan } = request;
  const events: RuntimeEvent[] = [];
  const emit = (data: Record<string, unknown>) => {
    const event: RuntimeEvent = { type: "json", data };
    events.push(event);
    request.onEvent?.(event);
  };
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new LoopStop("Process timed out.", 124)),
    request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const cancel = () => controller.abort(new LoopStop("Run cancelled.", 130));
  if (request.signal?.aborted) cancel();
  request.signal?.addEventListener("abort", cancel, { once: true });
  const outputBudget = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const tools = toolDefinitions(plan);
  const messages: ChatMessage[] = [{ role: "user", content: request.prompt }];
  const seen = new Map<string, number>();
  let toolCalls = 0;
  let outputBytes = 0;
  const checkAborted = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  try {
    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
      checkAborted();
      const reply = await request.chat({
        provider: plan.provider as CompletionProvider,
        model: plan.model,
        ...(plan.temperature === undefined
          ? {}
          : { temperature: plan.temperature }),
        messages,
        tools,
        maxAttempts: request.maxAttempts,
        signal: controller.signal,
        onEvent: request.onEvent,
      });
      messages.push(reply.message);
      const calls = reply.message.tool_calls ?? [];
      if (!calls.length) {
        emit({
          type: "completion",
          provider: plan.provider,
          model: reply.model,
          id: reply.id,
          usage: reply.usage,
          iterations: iteration,
          toolCalls,
          text: reply.message.content ?? "",
        });
        return { exitCode: 0, events, stderr: "" };
      }
      for (const call of calls) {
        checkAborted();
        toolCalls += 1;
        if (toolCalls > MAX_TOOL_CALLS)
          throw new LoopStop(
            `Tool call budget exhausted (${MAX_TOOL_CALLS}).`,
            1,
          );
        const key = `${call.function.name}\0${call.function.arguments}`;
        const repeats = (seen.get(key) ?? 0) + 1;
        seen.set(key, repeats);
        if (repeats >= MAX_REPEATS)
          throw new LoopStop(
            `Repeated tool call stopped the run: ${call.function.name} x${repeats}.`,
            1,
          );
        const decision = decideToolCall(plan, {
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
        let content: string;
        if (!decision.ok) {
          emit({
            type: "tool_denied",
            id: call.id,
            name: call.function.name,
            reason: decision.reason,
          });
          content = `denied: ${decision.reason}`;
        } else {
          emit({
            type: "tool_call",
            id: call.id,
            name: decision.name,
            arguments: redactRuntimeText(call.function.arguments).slice(
              0,
              2_000,
            ),
          });
          try {
            content = await request.executeTool(
              plan,
              decision.name,
              decision.args,
              controller.signal,
            );
            emit({
              type: "tool_result",
              id: call.id,
              ok: true,
              bytes: Buffer.byteLength(content),
            });
          } catch (error) {
            checkAborted();
            const message = redactRuntimeText((error as Error).message);
            // A refusal at execution (path outside the allowed paths, a credential file) is a
            // denial; any other failure is reported to the model, which may recover.
            if ((error as Error).name === "ToolDenied") {
              emit({
                type: "tool_denied",
                id: call.id,
                name: decision.name,
                reason: message,
              });
              content = `denied: ${message}`;
            } else {
              emit({
                type: "tool_result",
                id: call.id,
                ok: false,
                error: message,
              });
              content = `error: ${message}`;
            }
          }
        }
        outputBytes += Buffer.byteLength(content);
        if (outputBytes > outputBudget)
          throw new LoopStop("Output budget exceeded.", 125);
        messages.push({ role: "tool", tool_call_id: call.id, content });
      }
    }
    throw new LoopStop(`Iteration budget exhausted (${MAX_ITERATIONS}).`, 1);
  } catch (error) {
    const stop =
      error instanceof LoopStop
        ? error
        : controller.signal.aborted &&
            controller.signal.reason instanceof LoopStop
          ? controller.signal.reason
          : new LoopStop(
              (error as Error).message,
              (error as { exitCode?: number }).exitCode ?? 1,
            );
    return { exitCode: stop.exitCode, events, stderr: `${stop.message}\n` };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", cancel);
  }
}
