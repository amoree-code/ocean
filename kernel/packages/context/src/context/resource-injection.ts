import { contextAck } from "@ocean/core/shared/context-ack.js";
import { oceanEnvPair } from "@ocean/core/shared/paths.js";
import type { ProjectResolution } from "@ocean/core/shared/project-resolution.js";

// This module used to read Ocean files (memory, knowledge, inbox, README, governance rules)
// and inject their full content into every provider launch. That bulk injection is removed
// per T-198: providers get a tiny identity/bootstrap signal only, never Ocean file contents.
// On-demand reads happen through explicit Ocean operations (tasks, memory, knowledge, …),
// not through what gets stuffed into a launch argument or env var at startup.
export const OCEAN_BOOTSTRAP_MAX_BYTES = 256;

export type OceanBootstrap = {
  content: string;
  // The hash a client echoes as `contextAck` to show it loaded this line (T-319).
  ack: string;
  manifest: { bytes: number; source: "ocean"; transport: "bootstrap-env" };
};

const SUPPORTED_OPERATIONS = "context,tasks,memory-search,knowledge-search";

function projectTag(project: ProjectResolution): string {
  if (project.status === "bound") return project.projectId;
  return project.status;
}

// Bounded, client-neutral: identifies Ocean as canonical and the resolved project (or its
// absence), and names the on-demand operations a client can call. Never Ocean file content.
export function buildOceanBootstrap(
  project: ProjectResolution,
  extra: { rules?: number; profile?: string } = {},
): OceanBootstrap {
  const rules = extra.rules && extra.rules > 0 ? ` rules=${extra.rules}` : "";
  // The session's primary profile (T-338): a name only, its bundle is fetched on demand.
  const profile = extra.profile ? ` profile=${extra.profile}` : "";
  const line = `ocean=1 project=${projectTag(project)} confidence=${project.confidence}${rules}${profile} ops=${SUPPORTED_OPERATIONS}`;
  const ack = contextAck(line);
  const content = `${line} ack=${ack}`;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > OCEAN_BOOTSTRAP_MAX_BYTES) {
    throw new Error(
      `Ocean bootstrap exceeds the ${OCEAN_BOOTSTRAP_MAX_BYTES}-byte budget (${bytes} bytes): ${content}`,
    );
  }
  return {
    content,
    ack,
    manifest: { bytes, source: "ocean", transport: "bootstrap-env" },
  };
}

// Delivered as environment variables only — never written into provider argv or a
// provider-owned context file, and never a second source of truth for provider memory.
export function bootstrapEnvironment(
  bootstrap: OceanBootstrap,
): Record<string, string> {
  return {
    ...oceanEnvPair("BOOTSTRAP", bootstrap.content),
    ...oceanEnvPair("BOOTSTRAP_BYTES", String(bootstrap.manifest.bytes)),
  };
}
