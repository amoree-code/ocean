import type {
  HeadlessRunner,
  InteractiveRunner,
  ProviderRegistryPort,
} from "@ocean/core/domain/ports/platform-ports.js";

export type AuthDeps = {
  registry: ProviderRegistryPort;
  runHeadless: HeadlessRunner;
  runInteractive: InteractiveRunner;
};

export type AuthState =
  | "authenticated"
  | "login_required"
  | "failed"
  | "cancelled"
  | "not_supported";

type AuthAdapter = {
  provider: string;
  command: string;
  statusArgs: string[];
  loginArgs: string[];
  authenticated: (output: string, exitCode: number) => boolean;
};

const adapters: AuthAdapter[] = [
  {
    provider: "claude",
    command: "claude",
    statusArgs: ["auth", "status", "--json"],
    loginArgs: ["auth", "login", "--claudeai"],
    authenticated: (output, exitCode) =>
      exitCode === 0 && /"loggedIn"\s*:\s*true/i.test(output),
  },
  {
    provider: "codex",
    command: "codex",
    statusArgs: ["login", "status"],
    loginArgs: ["login", "--device-auth"],
    authenticated: (output, exitCode) =>
      exitCode === 0 && /logged in/i.test(output),
  },
  {
    provider: "kilo",
    command: "kilo",
    statusArgs: ["auth", "list"],
    loginArgs: ["auth", "login"],
    authenticated: (output, exitCode) =>
      exitCode === 0 && !/sign in|not logged|login required/i.test(output),
  },
];

export function authAdapter(provider: string): AuthAdapter | undefined {
  return adapters.find((adapter) => adapter.provider === provider);
}

export async function authStatus(
  provider: string,
  deps: AuthDeps,
): Promise<AuthState> {
  const adapter = authAdapter(provider);
  if (!adapter) return "not_supported";
  try {
    const executable = deps.registry.resolveOriginalExecutable(adapter.command);
    const result = await deps.runHeadless({
      command: executable,
      args: adapter.statusArgs,
      cwd: process.cwd(),
      timeoutMs: 15_000,
      maxOutputBytes: 8_000,
    });
    return adapter.authenticated(
      result.events
        .map((event) =>
          typeof event.data === "string"
            ? event.data
            : JSON.stringify(event.data),
        )
        .concat(result.stderr)
        .join("\n"),
      result.exitCode,
    )
      ? "authenticated"
      : result.exitCode === 0
        ? "login_required"
        : "failed";
  } catch {
    return "failed";
  }
}

export async function authLogin(
  provider: string,
  deps: AuthDeps,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<AuthState> {
  const adapter = authAdapter(provider);
  if (!adapter) return "not_supported";
  try {
    const executable = deps.registry.resolveOriginalExecutable(adapter.command);
    const result = await deps.runInteractive({
      command: executable,
      args: adapter.loginArgs,
      cwd: process.cwd(),
      ...options,
    });
    if (result.cancelled || result.timedOut) return "cancelled";
    if (result.exitCode !== 0) return "failed";
    return await authStatus(provider, deps);
  } catch {
    return "failed";
  }
}
