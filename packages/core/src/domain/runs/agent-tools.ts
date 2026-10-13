import path from "node:path";
import { z } from "zod";
import type { ExecutionPlan } from "./execution-plan.js";

// The tools a completion client may call in a tool-loop run (T-245 Phase 6), and the pure
// part of deciding whether one call may run. Filesystem bounds are checked again where the
// tool executes, against real paths.

const MAX_PATH = 1_024;
export const MAX_WRITE_BYTES = 256 * 1024;
const MAX_ARGS = 64;

const relativePath = z
  .string()
  .min(1)
  .max(MAX_PATH)
  .refine((value) => !value.includes("\0"), "path contains NUL");

const toolArgumentSchemas = {
  read_file: z.object({ path: relativePath }).strict(),
  list_directory: z.object({ path: relativePath }).strict(),
  write_file: z
    .object({
      path: relativePath,
      content: z
        .string()
        .refine(
          (value) => Buffer.byteLength(value) <= MAX_WRITE_BYTES,
          `content exceeds ${MAX_WRITE_BYTES} bytes`,
        ),
    })
    .strict(),
  run_command: z
    .object({
      command: z.string().min(1).max(128),
      args: z
        .array(
          z
            .string()
            .max(4_096)
            .refine((value) => !value.includes("\0"), "argument contains NUL"),
        )
        .max(MAX_ARGS)
        .default([]),
    })
    .strict(),
} as const;

export type ToolName = keyof typeof toolArgumentSchemas;
export type ToolArguments = {
  [Name in ToolName]: z.infer<(typeof toolArgumentSchemas)[Name]>;
};

// OpenAI-compatible function specs, as sent to the provider.
const toolSpecs: Record<ToolName, { description: string; parameters: object }> =
  {
    read_file: {
      description:
        "Read a UTF-8 text file. path is relative to the working directory.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    list_directory: {
      description:
        "List a directory. path is relative to the working directory; use . for it.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    write_file: {
      description:
        "Create or replace a UTF-8 text file with the full new content. path is relative to the working directory.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    run_command: {
      description:
        "Run one allowed command with arguments, without a shell, in the working directory.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  };

// Read tools always; write only in a workspace-write sandbox; commands only there and only
// when the profile allows at least one command.
export function offeredTools(plan: ExecutionPlan): ToolName[] {
  const tools: ToolName[] = ["read_file", "list_directory"];
  if (plan.sandbox.mode === "workspace-write") {
    tools.push("write_file");
    if (plan.sandbox.allowedCommands.length) tools.push("run_command");
  }
  return tools;
}

export function toolDefinitions(plan: ExecutionPlan): object[] {
  return offeredTools(plan).map((name) => ({
    type: "function",
    function: { name, ...toolSpecs[name] },
  }));
}

export type ToolCall = { id: string; name: string; arguments: string };

export type ToolDecision =
  | { ok: true; name: ToolName; args: ToolArguments[ToolName] }
  | { ok: false; reason: string };

// A call the model asked for is untrusted input: anything not offered, malformed, or outside
// the plan's command allowlist is denied before execution.
export function decideToolCall(
  plan: ExecutionPlan,
  call: ToolCall,
): ToolDecision {
  if (!(call.name in toolArgumentSchemas))
    return { ok: false, reason: `unknown tool: ${call.name}` };
  const name = call.name as ToolName;
  if (!offeredTools(plan).includes(name))
    return { ok: false, reason: `tool not allowed in this run: ${name}` };
  let input: unknown;
  try {
    input = JSON.parse(call.arguments || "{}");
  } catch {
    return { ok: false, reason: "arguments are not valid JSON" };
  }
  const parsed = toolArgumentSchemas[name].safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      reason: `invalid arguments: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`).join("; ")}`,
    };
  if (name === "run_command") {
    const { command } = parsed.data as ToolArguments["run_command"];
    // A bare name only: a path could point at any binary the allowlist did not mean.
    if (command.includes("/") || command.includes("\\"))
      return { ok: false, reason: "command must be a bare name, not a path" };
    if (
      !plan.sandbox.allowedCommands.some(
        (allowed) => path.basename(allowed) === command,
      )
    )
      return { ok: false, reason: `command not allowed: ${command}` };
  }
  return { ok: true, name, args: parsed.data };
}
