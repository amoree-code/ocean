import { redactSecrets } from "../redaction/redaction.js";
import { isApiClient, type Profile, selectProfileClient } from "./profile.js";
import { validateProfile } from "./profile-validator.js";

// Schema v1 → v2 for one profile file (T-245 Phase 5). Pure: the caller reads and writes.
// The result must behave exactly like the input; anything that cannot be carried over
// without a behaviour change, or that looks like a credential, is rejected instead.
export type ProfileUpgrade =
  | { status: "current" }
  | {
      status: "upgrade";
      profile: Record<string, unknown>;
      changes: string[];
    }
  | { status: "rejected"; issues: string[] };

const credentialKey = /api[-_]?key|token|secret|password|credential|bearer/i;

// Paths only, never values: the report is printed and must not repeat a secret.
function credentialIssues(value: unknown, at: string): string[] {
  if (typeof value === "string")
    return redactSecrets(value).includes("[REDACTED]")
      ? [`${at}: value looks like a credential`]
      : [];
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      credentialIssues(item, `${at}[${index}]`),
    );
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, item]) => [
      ...(credentialKey.test(key)
        ? [`${at}.${key}: credential-like field`]
        : []),
      ...credentialIssues(item, `${at}.${key}`),
    ]);
  return [];
}

const credentialHint =
  "credentials never belong in a profile; set DEEPSEEK_API_KEY or OPENROUTER_API_KEY in the environment instead";

function enabledClients(profile: Profile): string[] {
  return Object.entries(profile.clients)
    .filter(([, binding]) => binding.enabled)
    .map(([client]) => client);
}

// What a run would actually get from a profile, per enabled client. The upgrade must not
// change any of it.
function behaviour(profile: Profile): unknown {
  return {
    defaultClient: profile.defaultClient,
    clients: Object.fromEntries(
      (enabledClients(profile).length
        ? enabledClients(profile)
        : [profile.provider]
      ).map((client) => [client, selectProfileClient(profile, client).model]),
    ),
    allowedPaths: profile.allowedPaths,
    allowedCommands: profile.allowedCommands,
    writePolicy: profile.writePolicy,
    approvalRequired: profile.governance?.approvalRequired ?? false,
    skills: profile.skills,
    contextSources: profile.contextSources,
    instructions: profile.instructions,
    memoryEnabled:
      profile.memory.enabled && profile.memory.scope !== "disabled",
    verification: profile.verification,
    contextCompression: profile.contextCompression,
  };
}

export function upgradeProfile(raw: unknown): ProfileUpgrade {
  const input = (raw ?? {}) as Record<string, unknown>;
  const credentials = credentialIssues(raw, "profile");
  if (credentials.length)
    return { status: "rejected", issues: [...credentials, credentialHint] };
  let v1: Profile;
  try {
    v1 = validateProfile(raw);
  } catch (error) {
    return { status: "rejected", issues: [(error as Error).message] };
  }
  if (v1.schemaVersion === 2) return { status: "current" };

  const changes: string[] = [];
  const rawClients = (input.clients ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const clientNames = Object.keys(rawClients).length
    ? Object.keys(rawClients)
    : [v1.provider];
  const clients = Object.fromEntries(
    clientNames.map((client) => {
      const binding = rawClients[client] ?? { enabled: true };
      // The model a v1 run of this client gets, made explicit.
      const model =
        (binding.model as string | undefined) ??
        (client === v1.provider ? v1.model : "provider-managed");
      if (binding.model === undefined)
        changes.push(`clients.${client}.model: explicit "${model}"`);
      return [
        client,
        {
          ...binding,
          transport: isApiClient(client) ? "openai-compatible-api" : "cli",
          model,
        },
      ];
    }),
  );
  const scope = v1.memory.scope === "disabled" ? "disabled" : "profile";
  if (scope !== v1.memory.scope)
    changes.push(`memory.scope: "${v1.memory.scope}" -> "${scope}"`);
  const sandbox = {
    mode: v1.writePolicy === "none" ? "read-only" : "workspace-write",
    network: "provider-only",
    allowedHosts: [],
  };
  changes.push(`governance.sandbox: ${sandbox.mode}, ${sandbox.network}`);
  const governance = (input.governance ?? {}) as Record<string, unknown>;
  const profile: Record<string, unknown> = {
    schemaVersion: 2,
    name: v1.name,
    description: v1.description,
    version: v1.version,
    role: v1.role,
    // The raw list: an empty list still means "the role's default skills".
    skills: Array.isArray(input.skills) ? input.skills : [],
    contextSources: v1.contextSources,
    defaultClient: v1.defaultClient,
    clients,
    governance: {
      ...governance,
      allowedPaths: v1.allowedPaths,
      allowedCommands: v1.allowedCommands,
      writePolicy: v1.writePolicy,
      sandbox,
    },
    memory: { enabled: v1.memory.enabled, scope },
    verification: v1.verification,
    contextCompression: v1.contextCompression,
    instructions: v1.instructions,
  };
  let v2: Profile;
  try {
    v2 = validateProfile(profile);
  } catch (error) {
    return { status: "rejected", issues: [(error as Error).message] };
  }
  if (JSON.stringify(behaviour(v1)) !== JSON.stringify(behaviour(v2)))
    return {
      status: "rejected",
      issues: ["upgrade would change how this profile runs"],
    };
  return { status: "upgrade", profile, changes };
}
