// Composition root. This is the one place (besides entry points) allowed to
// import infrastructure concretes: it wires them to the domain ports that the
// application layer depends on. Dependencies point inward everywhere else —
// application → domain ports, never application → infrastructure.

import { brainIndexPort } from "@ocean/brain/infrastructure/brain/brain-index.js";
import type { BrainIndexPort } from "@ocean/core/domain/ports/brain-index-port.js";
import type {
  ProviderRegistryPort,
  WrapperManagerPort,
} from "@ocean/core/domain/ports/platform-ports.js";
import type { AgentRuntimeDeps } from "@ocean/core/domain/ports/runtime-ports.js";
import type {
  SessionStoreFactory,
  SessionStoreOpener,
} from "@ocean/core/domain/ports/session-store-port.js";
import {
  openSessionStore,
  SessionStore,
} from "@ocean/loop/infrastructure/persistence/session-store.js";
import type { AuthDeps } from "../application/auth/auth-orchestrator.js";
import { loadProfile } from "../infrastructure/filesystem/profile-loader.js";
import { loadSkillIndex } from "../infrastructure/filesystem/skill-loader.js";
import { appendRuntimeLog } from "../infrastructure/observability/runtime-logger.js";
import { executeAgentTool } from "../infrastructure/process/agent-tool-executor.js";
import { runHeadless } from "../infrastructure/process/cli-process.js";
import { runInteractive } from "../infrastructure/process/interactive-process.js";
import { resolveClientHome } from "../infrastructure/providers/client-home.js";
import {
  chatTransport,
  runCompletion,
} from "../infrastructure/providers/openai-compatible.js";
import { resolveOriginalExecutable } from "../infrastructure/providers/provider-registry.js";
import {
  assertProviderSupportsReadOnly,
  runProvider,
} from "../infrastructure/providers/providers.js";
import {
  desktopWrapperPath,
  registerProvider,
  removeProvider,
  syncProviderWrappers,
  wrapperDoctor,
} from "../infrastructure/wrappers/wrapper-manager.js";

/** The concrete session-store factory, as the SessionStoreFactory port. */
export const defaultSessionStoreFactory: SessionStoreFactory = openSessionStore;

/** Opens a session-store file at an arbitrary path, as the SessionStoreOpener port. */
export const defaultSessionStoreOpener: SessionStoreOpener = (file: string) =>
  new SessionStore(file);

/** The concrete brain-index driver (T-228), as the BrainIndexPort. */
export const defaultBrainIndexPort: BrainIndexPort = brainIndexPort;

/** The concrete dependency set for `runAgent`/`resumeAgent`. */
export const defaultAgentRuntime: AgentRuntimeDeps = {
  openStore: openSessionStore,
  executeProvider: runProvider,
  executeCompletion: runCompletion,
  chat: chatTransport,
  executeAgentTool,
  loadProfile,
  loadSkillIndex,
  resolveClientHome,
  appendRuntimeLog,
  assertProviderSupportsReadOnly,
};

/**
 * Build an agent runtime with the real implementations, overriding any subset —
 * used by tests to inject a fake provider executor while keeping the rest real.
 */
export function createAgentRuntime(
  overrides: Partial<AgentRuntimeDeps> = {},
): AgentRuntimeDeps {
  return { ...defaultAgentRuntime, ...overrides };
}

/** Shell wrapper management, as the WrapperManagerPort. */
export const defaultWrapperManager: WrapperManagerPort = {
  syncProviderWrappers,
  registerProvider,
  removeProvider,
  wrapperDoctor,
  desktopWrapperPath,
};

/** The provider registry, as the ProviderRegistryPort. */
export const defaultProviderRegistry: ProviderRegistryPort = {
  resolveOriginalExecutable,
};

/** Dependencies for the auth flows. */
export const defaultAuthDeps: AuthDeps = {
  registry: defaultProviderRegistry,
  runHeadless,
  runInteractive,
};
