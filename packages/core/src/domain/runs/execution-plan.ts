import { createHash } from "node:crypto";
import {
  isApiClient,
  type Profile,
  profileIdentity,
  type Transport,
} from "../profiles/profile.js";

// The immutable answer to "what exactly will this run do", fixed before any process or
// request starts and recorded at session start (T-245). Every value is resolved from the
// validated profile and the run request; nothing is read from the ambient environment.
export type ExecutionPlan = Readonly<{
  profileName: string;
  profileIdentity: string;
  client: Profile["provider"];
  transport: Transport;
  provider: string;
  model: string;
  temperature?: number;
  // A completion client running Ocean's bounded tool loop instead of a single completion.
  toolLoop: boolean;
  memoryNamespace: string | null;
  cwd: string;
  readOnly: boolean;
  allowedPaths: readonly string[];
  allowedCommands: readonly string[];
  // Compatibility variables for the child process only: outputs of the plan, never inputs.
  childEnv: Readonly<Record<string, string>>;
}>;

export type ExecutionPlanOptions = {
  cwd: string;
  // Transports this runtime can execute. A binding on any other transport fails closed.
  supportedTransports: readonly Transport[];
  // Whether this run may write: an approved run contract grants it and the runtime executes
  // it. The run writes only when the profile's write policy allows it too.
  writeAllowed: boolean;
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// One definition, used by the plan and by the caller that decides whether writes are granted.
export function usesToolLoop(profile: Profile): boolean {
  const binding = profile.clients[profile.provider];
  return (
    isApiClient(profile.provider) &&
    binding?.transport !== "cli" &&
    binding?.toolLoop === true
  );
}

// `profile` is the result of selectProfileClient: its provider is the selected client.
export function buildExecutionPlan(
  profile: Profile,
  options: ExecutionPlanOptions,
): ExecutionPlan {
  const client = profile.provider;
  const binding = profile.clients[client];
  const transport =
    binding?.transport ??
    (isApiClient(client) ? "openai-compatible-api" : "cli");
  if (!options.supportedTransports.includes(transport))
    throw new Error(`Unsupported transport for client ${client}: ${transport}`);
  const memoryNamespace =
    profile.memory.enabled && profile.memory.scope !== "disabled"
      ? profile.name
      : null;
  return deepFreeze({
    profileName: profile.name,
    profileIdentity: profileIdentity(profile),
    client,
    transport,
    provider: client,
    model: profile.model,
    ...(binding?.temperature === undefined
      ? {}
      : { temperature: binding.temperature }),
    toolLoop: usesToolLoop(profile),
    memoryNamespace,
    cwd: options.cwd,
    readOnly: profile.writePolicy === "none" || !options.writeAllowed,
    allowedPaths: [...profile.allowedPaths],
    allowedCommands: [...profile.allowedCommands],
    childEnv: {
      OCEAN_CURRENT_PROFILE: profile.name,
      OCEAN_TARGET_PROVIDER: client,
      OCEAN_TARGET_MODEL: profile.model,
      OCEAN_MEMORY_SCOPE: memoryNamespace ?? "disabled",
    },
  });
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
    );
  return value;
}

// Keys are sorted recursively, so the identity depends only on the plan's values.
export function executionPlanIdentity(plan: ExecutionPlan): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(plan)))
    .digest("hex");
}
