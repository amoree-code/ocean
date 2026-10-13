import type { HeadlessResult } from "../process/process-events.js";
import type { Profile } from "../profiles/profile.js";
import type {
  CompletionRequest,
  HeadlessProvider,
  ProviderRequest,
} from "../providers/provider.js";
import type { SkillIndexEntry } from "../skills/skill.js";
import type { SessionStoreFactory } from "./session-store-port.js";

// Function ports the application depends on. The composition root binds these to
// their infrastructure implementations; application code never imports the
// concretes.

export type ProviderExecutor = (
  request: ProviderRequest,
) => Promise<HeadlessResult>;

export type CompletionExecutor = (
  request: CompletionRequest,
) => Promise<HeadlessResult>;

export type ProfileLoader = (name: string) => Promise<Profile>;

// Resolves profile skill names to their catalog metadata and SKILL.md path without reading
// any body: headless prompts carry a skill index, and the provider loads a body on demand.
export type SkillIndexLoader = (
  names: string[],
  cwd?: string,
) => Promise<SkillIndexEntry[]>;

export type ClientHomeResolver = (profile: Profile) => string | undefined;

export type RuntimeLogEntry = {
  timestamp: string;
  event: string;
  correlationId: string;
  provider?: string;
  sessionId?: string;
  status?: string;
  payload?: string;
};
export type RuntimeLogger = (log: RuntimeLogEntry) => Promise<void>;

export type ReadOnlyAssertion = (provider: HeadlessProvider) => void;

/**
 * The full set of infrastructure dependencies `runAgent`/`resumeAgent` need.
 * The composition root supplies concrete implementations; the run functions
 * import only this type from the domain layer.
 */
export type AgentRuntimeDeps = {
  openStore: SessionStoreFactory;
  executeProvider: ProviderExecutor;
  executeCompletion: CompletionExecutor;
  loadProfile: ProfileLoader;
  loadSkillIndex: SkillIndexLoader;
  resolveClientHome: ClientHomeResolver;
  appendRuntimeLog: RuntimeLogger;
  assertProviderSupportsReadOnly: ReadOnlyAssertion;
};
