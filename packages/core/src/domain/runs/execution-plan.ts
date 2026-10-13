import { createHash } from "node:crypto";
import {
  type Profile,
  profileIdentity,
  type SandboxPolicy,
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
  memoryNamespace: string | null;
  cwd: string;
  readOnly: boolean;
  sandbox: Readonly<{
    mode: SandboxPolicy["mode"];
    network: SandboxPolicy["network"];
    allowedPaths: readonly string[];
    allowedCommands: readonly string[];
    allowedHosts: readonly string[];
  }>;
  // Compatibility variables for the child process only: outputs of the plan, never inputs.
  childEnv: Readonly<Record<string, string>>;
}>;

export type ExecutionPlanOptions = {
  cwd: string;
  // Transports this runtime can execute. A binding on any other transport fails closed.
  supportedTransports: readonly Transport[];
  // Whether this run may write: the profile allows it, an approved run contract grants it,
  // and the runtime can enforce it. The effective sandbox is the strictest of the three.
  writeAllowed: boolean;
  // Network policies the selected client can enforce. A stricter policy it cannot enforce
  // fails closed rather than running with a weaker one.
  enforceableNetwork: readonly SandboxPolicy["network"][];
};

// A v1 profile has no sandbox block; it maps to the policy it already implied.
function profileSandbox(profile: Profile): SandboxPolicy {
  return (
    profile.governance?.sandbox ?? {
      mode: profile.writePolicy === "none" ? "read-only" : "workspace-write",
      network: "provider-only",
      allowedHosts: [],
    }
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// `profile` is the result of selectProfileClient: its provider is the selected client.
export function buildExecutionPlan(
  profile: Profile,
  options: ExecutionPlanOptions,
): ExecutionPlan {
  const client = profile.provider;
  const binding = profile.clients[client];
  const transport = binding?.transport ?? "cli";
  if (!options.supportedTransports.includes(transport))
    throw new Error(`Unsupported transport for client ${client}: ${transport}`);
  const sandbox = profileSandbox(profile);
  if (!options.enforceableNetwork.includes(sandbox.network))
    throw new Error(
      `Client ${client} cannot enforce network policy: ${sandbox.network}`,
    );
  const mode =
    sandbox.mode === "workspace-write" && options.writeAllowed
      ? "workspace-write"
      : "read-only";
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
    memoryNamespace,
    cwd: options.cwd,
    readOnly: mode === "read-only",
    sandbox: {
      mode,
      network: sandbox.network,
      allowedPaths: [...profile.allowedPaths],
      allowedCommands: [...profile.allowedCommands],
      allowedHosts: [...sandbox.allowedHosts],
    },
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
