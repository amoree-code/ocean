import type { HeadlessResult } from "../process/process-events.js";
import type { Profile } from "../profiles/profile.js";
import type {
  ChatReply,
  ChatRequest,
  CompletionRequest,
  HeadlessProvider,
  ProviderRequest,
} from "../providers/provider.js";
import type { ToolArguments, ToolName } from "../runs/agent-tools.js";
import type { ExecutionPlan } from "../runs/execution-plan.js";
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

// One tool-loop turn against a completion client (T-245 Phase 6).
export type ChatPort = (request: ChatRequest) => Promise<ChatReply>;

// Runs one tool call that the plan has already allowed.
export type AgentToolPort = (
  plan: ExecutionPlan,
  name: ToolName,
  args: ToolArguments[ToolName],
  signal: AbortSignal,
) => Promise<string>;

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
  chat: ChatPort;
  executeAgentTool: AgentToolPort;
  loadProfile: ProfileLoader;
  loadSkillIndex: SkillIndexLoader;
  resolveClientHome: ClientHomeResolver;
  appendRuntimeLog: RuntimeLogger;
  assertProviderSupportsReadOnly: ReadOnlyAssertion;
};
