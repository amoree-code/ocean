import { z } from "zod";

export const capabilityContractSchema = z.object({
  capability: z.string().min(1),
  operation: z.string().min(1),
  authority: z.enum(["profile", "session", "owner"]),
  idempotency: z.enum(["safe", "repeatable", "non-repeatable"]),
  verification: z.string().min(1),
});
export type CapabilityContract = z.infer<typeof capabilityContractSchema>;
export const workspaceReadContract = capabilityContractSchema.parse({
  capability: "workspace",
  operation: "read",
  authority: "profile",
  idempotency: "safe",
  verification: "sha256 content hash",
});
