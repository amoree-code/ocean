import { createHash } from "node:crypto";
import { z } from "zod";

export const mcpToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  // Hints for the client's own permission UI. They are not enforcement: the server's own
  // checks (roots, secrets, the writes switch) decide what a call may do.
  annotations: z
    .object({
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
    })
    .optional(),
});
export type McpTool = z.infer<typeof mcpToolSchema>;
export const mcpApprovalSchema = z.object({
  approved: z.literal(true),
  fingerprint: z.string().length(64),
});

export function actionFingerprint(
  name: string,
  args: Record<string, unknown>,
): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => key !== "approval" && key !== "approved")
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  };
  return createHash("sha256")
    .update(JSON.stringify({ name, arguments: canonical(args) }))
    .digest("hex");
}
