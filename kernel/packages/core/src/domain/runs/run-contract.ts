import { z } from "zod";

const runContractSchema = z
  .object({
    runId: z.string().min(1),
    sessionId: z.string().min(1),
    profile: z.string().min(1),
    workingDirectory: z.string().min(1),
    allowedTools: z.array(z.string().min(1)).default([]),
    deniedTools: z.array(z.string().min(1)).default([]),
    stopConditions: z.array(z.string().min(1)).min(1),
    approval: z.object({ required: z.boolean(), approved: z.boolean() }),
    budget: z.object({
      timeoutMs: z.number().int().positive(),
      maxAttempts: z.number().int().positive(),
      maxOutputBytes: z.number().int().positive(),
    }),
  })
  .superRefine((contract, context) => {
    const overlap = contract.allowedTools.filter((tool) =>
      contract.deniedTools.includes(tool),
    );
    if (overlap.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deniedTools"],
        message: `Tool is both allowed and denied: ${overlap[0]}`,
      });
    if (contract.approval.required && contract.approval.approved === false)
      return;
  });

export type RunContract = z.infer<typeof runContractSchema>;

export function validateRunContract(input: unknown): RunContract {
  return runContractSchema.parse(input);
}

export function assertRunCanStart(contract: RunContract, attempt = 1): void {
  if (contract.approval.required && !contract.approval.approved)
    throw new Error("Run approval required");
  if (attempt > contract.budget.maxAttempts)
    throw new Error(`Run attempt limit exceeded: ${attempt}`);
}
