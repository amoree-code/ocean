import path from "node:path";
import type {
  HeadlessProvider,
  ProviderAdapter,
  ProviderRequest,
} from "../../domain/providers/provider.js";
import { type HeadlessResult, runHeadless } from "../process/cli-process.js";
import { resolveOriginalExecutable } from "./provider-registry.js";

// Provider contracts live in the domain layer; re-exported here for existing callers.
export type {
  HeadlessProvider,
  ProviderAdapter,
  ProviderRequest,
} from "../../domain/providers/provider.js";

// One flag per directory; never variadic, so the next argument cannot be swallowed.
function repeatFlag(flag: string, values: string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => [flag, value]);
}

// The model is enforced with each client's own flag, never only described in the prompt.
// Flags verified against each installed CLI's --help on 2026-10-13.
function modelFlag(flag: string, model: string | undefined): string[] {
  return model && model !== "provider-managed" ? [flag, model] : [];
}

export const providerAdapterRegistry: Readonly<
  Record<HeadlessProvider, ProviderAdapter>
> = {
  claude: {
    provider: "claude",
    capabilities: ["headless", "resume", "read-only"],
    readOnlyArgs: ["--permission-mode", "plan", "--restricted"],
    build: (request) => [
      ...(request.resumeId ? ["--resume", request.resumeId] : []),
      ...modelFlag("--model", request.model),
      ...(request.readOnly
        ? ["--permission-mode", "plan", "--restricted"]
        : []),
      ...repeatFlag("--add-dir", request.readDirectories),
      "-p",
      request.prompt,
      "--verbose",
      "--output-format",
      "stream-json",
    ],
  },
  codex: {
    provider: "codex",
    capabilities: ["headless", "read-only"],
    readOnlyArgs: ["--sandbox", "read-only"],
    build: (request) => [
      "exec",
      ...modelFlag("--model", request.model),
      ...(request.readOnly ? ["--sandbox", "read-only"] : []),
      "--json",
      "--skip-git-repo-check",
      request.prompt,
    ],
  },
  gemini: {
    provider: "gemini",
    capabilities: ["headless", "read-only"],
    readOnlyArgs: ["--approval-mode=plan"],
    build: (request) => [
      ...modelFlag("--model", request.model),
      ...(request.readOnly ? ["--approval-mode=plan"] : []),
      ...repeatFlag("--include-directories", request.readDirectories),
      "--prompt",
      request.prompt,
      "--output-format",
      "stream-json",
    ],
  },
  antigravity: {
    provider: "antigravity",
    capabilities: ["headless", "read-only"],
    readOnlyArgs: ["--mode", "plan", "--sandbox"],
    build: (request) => [
      ...modelFlag("--model", request.model),
      ...(request.readOnly ? ["--mode", "plan", "--sandbox"] : []),
      "--print",
      request.prompt,
      "--output-format",
      "stream-json",
    ],
  },
  hermes: {
    provider: "hermes",
    capabilities: ["headless"],
    build: (request) => [
      ...modelFlag("-m", request.model),
      "-z",
      request.prompt,
    ],
  },
  kilo: {
    provider: "kilo",
    capabilities: ["headless"],
    build: (request) => [
      "run",
      ...modelFlag("--model", request.model),
      "--auto",
      request.prompt,
    ],
  },
  kimi: {
    provider: "kimi",
    capabilities: ["headless", "read-only"],
    readOnlyArgs: ["--plan"],
    build: (request) => [
      ...modelFlag("--model", request.model),
      ...(request.readOnly ? ["--plan"] : []),
      "--prompt",
      request.prompt,
      "--print",
      "--output-format",
      "stream-json",
    ],
  },
};

export function buildProviderInvocation(request: ProviderRequest): {
  command: string;
  args: string[];
} {
  const command = request.provider === "antigravity" ? "agy" : request.provider;
  const adapter = providerAdapterRegistry[request.provider];
  if (request.readOnly) assertProviderSupportsReadOnly(request.provider);
  const args = adapter.build(request);

  return { command, args };
}

export function assertProviderSupportsReadOnly(
  provider: HeadlessProvider,
): void {
  if (!providerAdapterRegistry[provider].capabilities.includes("read-only"))
    throw new Error(`Provider cannot enforce read-only execution: ${provider}`);
}

export function runProvider(request: ProviderRequest): Promise<HeadlessResult> {
  const { command, args } = buildProviderInvocation(request);
  return runHeadless({
    command: resolveOriginalExecutable(command),
    args,
    cwd: path.resolve(request.cwd),
    // Built fresh for every run: the plan's variables override any inherited value of the
    // same name, and nothing is written back to this process's environment.
    env: {
      ...request.env,
      ...(request.provider === "hermes" && request.clientHome
        ? { HERMES_HOME: request.clientHome }
        : {}),
    },
    timeoutMs: request.timeoutMs,
    maxOutputBytes: request.maxOutputBytes,
    onEvent: request.onEvent,
    onSpawn: request.onSpawn,
  });
}
