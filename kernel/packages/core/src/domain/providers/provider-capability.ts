import { z } from "zod";

export const providerCapabilitySchema = z.object({
  provider: z.enum([
    "claude",
    "codex",
    "gemini",
    "antigravity",
    "hermes",
    "kilo",
    "kimi",
  ]),
  command: z.string().min(1),
  installed: z.boolean(),
  headless: z.boolean(),
  resume: z.boolean(),
  streaming: z.boolean(),
  structuredOutput: z.boolean(),
  authentication: z.enum(["cli-managed", "unknown"]),
  interactive: z.boolean().default(true),
  interactiveContext: z
    .enum(["verified", "partial", "not-proven"])
    .default("not-proven"),
  contextTransport: z.string().min(1).default("provider-specific"),
  inputCapture: z
    .enum(["semantic", "bounded-terminal", "none"])
    .default("bounded-terminal"),
});
export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;
