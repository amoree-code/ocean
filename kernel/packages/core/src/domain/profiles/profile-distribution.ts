import { z } from "zod";

const profileDistributionSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().default(""),
    oceanRequires: z.string().optional(),
    clients: z.array(z.string().min(1)).default([]),
    files: z.array(z.string().min(1)).default([]),
    distributionOwned: z.array(z.string().min(1)).default(["profile.json"]),
  })
  .transform(({ oceanRequires, ...rest }) => ({
    ...rest,
    oceanRequires: oceanRequires ?? "*",
  }));

export type ProfileDistribution = z.infer<typeof profileDistributionSchema>;

export function validateProfileDistribution(
  input: unknown,
): ProfileDistribution {
  return profileDistributionSchema.parse(input);
}
