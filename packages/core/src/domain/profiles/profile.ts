import { createHash } from "node:crypto";
import { z } from "zod";
import { defaultSkillNames } from "../skills/default-skills.js";

const providerSchema = z.enum([
  "claude",
  "codex",
  "gemini",
  "antigravity",
  "hermes",
  "kilo",
  "kimi",
]);
const clientBindingSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().min(1).optional(),
  profile: z.string().min(1).optional(),
  home: z.string().min(1).optional(),
  mode: z.string().min(1).optional(),
  capabilities: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
});
const governanceSchema = z.object({
  allowedPaths: z.array(z.string()).optional(),
  allowedCommands: z.array(z.string()).optional(),
  writePolicy: z.enum(["none", "workspace", "allowed-paths"]).optional(),
  approvalRequired: z.boolean().optional(),
  network: z.string().min(1).optional(),
});

// A profile name is also a filename (profiles/<name>.json) and a memory namespace
// (memory/profiles/<name>.json), so it is restricted to characters that can never form a path.
const profileNamePattern = /^[A-Za-z0-9_-]+$/;

export function assertProfileName(name: string): string {
  if (!profileNamePattern.test(name)) throw new Error("Invalid profile name");
  return name;
}

const rawProfileSchema = z.object({
  name: z.string().regex(profileNamePattern, "Invalid profile name"),
  description: z.string().default(""),
  version: z.string().min(1).default("1.0.0"),
  provider: providerSchema.optional(),
  model: z.string().min(1).optional(),
  role: z.string().min(1),
  skills: z.array(z.string()).default([]),
  allowedPaths: z.array(z.string()).default([]),
  allowedCommands: z.array(z.string()).default([]),
  writePolicy: z.enum(["none", "workspace", "allowed-paths"]).default("none"),
  contextSources: z.array(z.string()).default([]),
  clients: z.record(z.string(), clientBindingSchema).default({}),
  defaultClient: providerSchema.optional(),
  governance: governanceSchema.optional(),
  memory: z
    .object({
      enabled: z.boolean().default(true),
      scope: z.string().min(1).default("profile"),
    })
    .default({ enabled: true, scope: "profile" }),
  verification: z
    .object({ commands: z.array(z.string()).default([]) })
    .default({ commands: [] }),
  contextCompression: z.enum(["none", "ocean-bounded"]).default("none"),
  instructions: z.string().default(""),
});

export const profileSchema = rawProfileSchema
  .superRefine((input, context) => {
    for (const client of Object.keys(input.clients)) {
      if (!providerSchema.safeParse(client).success)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["clients", client],
          message: `Unsupported client: ${client}`,
        });
    }
    if (
      !input.provider &&
      !input.defaultClient &&
      !Object.entries(input.clients).some(([, binding]) => binding.enabled)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clients"],
        message: "Profile must select a provider or an enabled client",
      });
    }
  })
  .transform((input) => {
    const provider =
      input.provider ??
      input.defaultClient ??
      (Object.entries(input.clients).find(
        ([, binding]) => binding.enabled,
      )?.[0] as z.infer<typeof providerSchema>);
    const model =
      input.model ?? input.clients[provider]?.model ?? "provider-managed";
    const governance = input.governance ?? {};
    return {
      ...input,
      skills: input.skills.length
        ? input.skills
        : defaultSkillNames(input.role),
      provider,
      model,
      defaultClient: input.defaultClient ?? provider,
      allowedPaths: governance.allowedPaths ?? input.allowedPaths,
      allowedCommands: governance.allowedCommands ?? input.allowedCommands,
      writePolicy: governance.writePolicy ?? input.writePolicy,
    };
  });

export type Profile = z.infer<typeof profileSchema>;

export function selectProfileClient(
  profile: Profile,
  requested?: string,
): Profile {
  const value = requested ?? profile.defaultClient ?? profile.provider;
  const parsed = providerSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Unsupported client: ${value}`);
  const client = parsed.data;
  const binding = profile.clients[client];
  if (Object.keys(profile.clients).length && !binding?.enabled)
    throw new Error(`Client is not enabled for profile: ${client}`);
  return {
    ...profile,
    provider: client,
    defaultClient: client,
    model: binding?.model ?? profile.model,
  };
}

// A deterministic identity for the exact configuration a profile had at the moment a
// session was created from it: same fields (including `version`) always hash to the same
// value, so a session can be traced back to the profile shape that produced it even after
// the profile file on disk is later edited. Key order is fixed explicitly rather than
// relying on object insertion order, since callers may construct a Profile in any order.
export function profileIdentity(profile: Profile): string {
  const canonical = {
    name: profile.name,
    description: profile.description,
    version: profile.version,
    provider: profile.provider,
    model: profile.model,
    role: profile.role,
    skills: profile.skills,
    allowedPaths: profile.allowedPaths,
    allowedCommands: profile.allowedCommands,
    writePolicy: profile.writePolicy,
    contextSources: profile.contextSources,
    clients: profile.clients,
    defaultClient: profile.defaultClient,
    memory: profile.memory,
    verification: profile.verification,
    contextCompression: profile.contextCompression,
    instructions: profile.instructions,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
