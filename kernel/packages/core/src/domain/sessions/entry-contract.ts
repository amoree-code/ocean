import { z } from "zod";

const sessionEntryPointSchema = z.enum([
  "ocean-run",
  "terminal-shim",
  "interactive-managed",
  "desktop-wrapper",
]);
const sessionControlLevelSchema = z.enum([
  "full-head",
  "managed-partial",
  "observed",
  "bypass",
]);
const sessionInputCaptureSchema = z.enum([
  "semantic",
  "bounded-terminal",
  "none",
]);

const sessionEntryContractSchema = z.object({
  entryPoint: sessionEntryPointSchema,
  controlLevel: sessionControlLevelSchema,
  inputCapture: sessionInputCaptureSchema,
  contextTransport: z.string().min(1),
  policyEnforcement: z.string().min(1),
  promotion: z.literal("explicit-review"),
  resume: z.string().min(1),
});

export type SessionEntryContract = z.infer<typeof sessionEntryContractSchema>;

export function validateSessionEntryContract(
  contract: SessionEntryContract,
): SessionEntryContract {
  return sessionEntryContractSchema.parse(contract);
}
