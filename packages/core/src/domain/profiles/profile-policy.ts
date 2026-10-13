import path from "node:path";
import { type ApiClient, isApiClient, type Profile } from "./profile.js";

const providerCommand: Record<
  Exclude<Profile["provider"], ApiClient>,
  string
> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  antigravity: "agy",
  hermes: "hermes",
  kilo: "kilo",
  kimi: "kimi",
};

export type ExecutionPolicy = {
  // null for a completion client: it calls a fixed HTTP endpoint and runs no command.
  providerCommand: string | null;
  writePolicy: Profile["writePolicy"];
  allowedPaths: string[];
};

export function executionPolicy(
  profile: Profile,
  cwd: string,
): ExecutionPolicy {
  const command = isApiClient(profile.provider)
    ? null
    : providerCommand[profile.provider];
  if (
    command !== null &&
    profile.allowedCommands.length &&
    !profile.allowedCommands.some(
      (allowed) =>
        command === allowed ||
        path.basename(command) === path.basename(allowed),
    )
  ) {
    throw new Error(`Policy denied provider command: ${command}`);
  }
  if (
    profile.writePolicy === "allowed-paths" &&
    profile.allowedPaths.length === 0
  ) {
    throw new Error("Policy denied writable run without allowed paths");
  }
  if (!path.isAbsolute(cwd))
    throw new Error("Policy denied non-absolute working directory");
  return {
    providerCommand: command,
    writePolicy: profile.writePolicy,
    allowedPaths: profile.allowedPaths,
  };
}
