import { createHash } from "node:crypto";
import { z } from "zod";
import { defaultSkillNames } from "../skills/default-skills.js";

const cliClients = [
  "claude",
  "codex",
  "gemini",
  "antigravity",
  "hermes",
  "kilo",
  "kimi",
] as const;
// Completion clients reached over HTTP at a fixed endpoint (T-245 Phase 4). They return text;
// they never spawn a process or touch the workspace.
const apiClients = ["deepseek", "openrouter"] as const;
const providerSchema = z.enum([...cliClients, ...apiClients]);

export type ApiClient = (typeof apiClients)[number];

export function isApiClient(client: string): client is ApiClient {
  return (apiClients as readonly string[]).includes(client);
}
// A model is passed to a CLI as the argument after its model flag; a leading "-" could be
// read as another flag.
const modelSchema = z
  .string()
  .min(1)
  .refine((model) => !model.startsWith("-"), "A model cannot start with -");

export const transportSchema = z.enum(["cli", "openai-compatible-api"]);
export type Transport = z.infer<typeof transportSchema>;

// `transport` and `temperature` stay optional (no default) so a v1 binding parses to exactly
// the object it parsed to before schema v2, and its profile identity is unchanged.
const clientBindingSchema = z.object({
  enabled: z.boolean().default(true),
  transport: transportSchema.optional(),
  model: modelSchema.optional(),
  temperature: z.number().min(0).max(2).optional(),
  profile: z.string().min(1).optional(),
  home: z.string().min(1).optional(),
  mode: z.string().min(1).optional(),
  capabilities: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
});
const sandboxSchema = z.object({
  mode: z.enum(["read-only", "workspace-write"]),
  network: z.enum(["deny", "provider-only", "allowlist"]),
  allowedHosts: z.array(z.string().min(1)).default([]),
});
export type SandboxPolicy = z.infer<typeof sandboxSchema>;

const governanceSchema = z.object({
  allowedPaths: z.array(z.string()).optional(),
  allowedCommands: z.array(z.string()).optional(),
  writePolicy: z.enum(["none", "workspace", "allowed-paths"]).optional(),
  approvalRequired: z.boolean().optional(),
  network: z.string().min(1).optional(),
  sandbox: sandboxSchema.optional(),
});

// A profile name is also a filename (profiles/<name>.json) and a memory namespace
// (memory/profiles/<name>.json), so it is restricted to characters that can never form a path.
// Lowercase only: on a case-insensitive filesystem "Alpha" and "alpha" would share one file.
const profileNamePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function assertProfileName(name: string): string {
  // typeof first: RegExp#test coerces, so null would otherwise pass as "null".
  if (typeof name !== "string" || !profileNamePattern.test(name))
    throw new Error("Invalid profile name");
  return name;
}

const rawProfileSchema = z.object({
  // Absent means 1. Schema v1 stays readable for one release; v2 is what new profiles use.
  schemaVersion: z.union([z.literal(1), z.literal(2)]).default(1),
  name: z.string().regex(profileNamePattern, "Invalid profile name"),
  description: z.string().default(""),
  version: z.string().min(1).default("1.0.0"),
  provider: providerSchema.optional(),
  model: modelSchema.optional(),
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

// Schema v2 makes explicit what v1 left to defaults: a default client, a model on every
// enabled client, a closed memory scope, and a sandbox policy.
function refineV2(
  input: z.infer<typeof rawProfileSchema>,
  context: z.RefinementCtx,
): void {
  const issue = (path: (string | number)[], message: string) =>
    context.addIssue({ code: z.ZodIssueCode.custom, path, message });
  if (!input.defaultClient)
    issue(["defaultClient"], "Schema v2 requires a defaultClient");
  else if (!input.clients[input.defaultClient]?.enabled)
    issue(["defaultClient"], "defaultClient must be an enabled client");
  for (const [client, binding] of Object.entries(input.clients))
    if (binding.enabled && !binding.model)
      issue(["clients", client, "model"], "Schema v2 requires a model");
  if (!["profile", "disabled"].includes(input.memory.scope))
    issue(
      ["memory", "scope"],
      'Schema v2 memory.scope is "profile" or "disabled"',
    );
  const sandbox = input.governance?.sandbox;
  if (!sandbox)
    issue(["governance", "sandbox"], "Schema v2 requires a sandbox");
  else {
    if (sandbox.network === "allowlist" && !sandbox.allowedHosts.length)
      issue(["governance", "sandbox", "allowedHosts"], "allowlist needs hosts");
    const writePolicy = input.governance?.writePolicy ?? input.writePolicy;
    if (sandbox.mode === "workspace-write" && writePolicy === "none")
      issue(
        ["governance", "sandbox", "mode"],
        'workspace-write conflicts with writePolicy "none"',
      );
  }
}

export const profileSchema = rawProfileSchema
  .superRefine((input, context) => {
    if (input.schemaVersion === 2) refineV2(input, context);
    for (const [client, binding] of Object.entries(input.clients)) {
      if (!providerSchema.safeParse(client).success)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["clients", client],
          message: `Unsupported client: ${client}`,
        });
      // A client's transport is fixed by what it is: a CLI cannot be called over HTTP and a
      // completion API cannot be spawned. An API client has no provider default model.
      const expected = isApiClient(client) ? "openai-compatible-api" : "cli";
      if (binding.transport && binding.transport !== expected)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["clients", client, "transport"],
          message: `Client ${client} uses transport ${expected}`,
        });
      if (isApiClient(client) && binding.enabled && !binding.model)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["clients", client, "model"],
          message: `Client ${client} requires a model`,
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
  // The profile-level model belongs to the profile's own provider. Another client without a
  // model of its own keeps its provider default: since the model became a CLI flag, passing
  // e.g. a Claude model to codex would break the run.
  return {
    ...profile,
    provider: client,
    defaultClient: client,
    model:
      binding?.model ??
      (client === profile.provider ? profile.model : "provider-managed"),
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
    // v2-only fields are appended only for v2, so every v1 identity stays what it was and a
    // v1 session can still be resumed after this release.
    ...(profile.schemaVersion === 2
      ? {
          schemaVersion: profile.schemaVersion,
          sandbox: profile.governance?.sandbox,
        }
      : {}),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
