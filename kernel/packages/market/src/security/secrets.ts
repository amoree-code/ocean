import { spawnSync } from "node:child_process";

// Where an installed server's secrets (API keys, tokens) live: never in a file Ocean writes. On
// macOS that is the login keychain, one generic password per capability and name under the
// service `ocean-mcp`; elsewhere there is no store yet and values come from the environment.
export interface SecretStore {
  readonly name: string;
  get(capability: string, name: string): string | undefined;
  set(capability: string, name: string, value: string): void;
  remove(capability: string, name: string): boolean;
}

const SERVICE = "ocean-mcp";
const account = (capability: string, name: string) => `${capability}:${name}`;

type Run = (
  command: string,
  args: string[],
  input?: string,
) => { status: number | null; stdout: string };

const run: Run = (command, args, input) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { status: result.status, stdout: result.stdout ?? "" };
};

// `security -i` reads its commands from stdin, so the value never appears in a process list.
const quote = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`;

export function keychainStore(
  platform: NodeJS.Platform = process.platform,
  runner: Run = run,
): SecretStore {
  if (platform !== "darwin")
    return {
      name: "none",
      get: () => undefined,
      set: () => {
        throw new Error(
          `no secret store on ${platform} yet; set the variable in the environment of the client instead`,
        );
      },
      remove: () => false,
    };
  return {
    name: "macOS keychain",
    get(capability, name) {
      const result = runner("security", [
        "find-generic-password",
        "-s",
        SERVICE,
        "-a",
        account(capability, name),
        "-w",
      ]);
      return result.status === 0 ? result.stdout.replace(/\n$/, "") : undefined;
    },
    set(capability, name, value) {
      if (/[\r\n]/.test(value))
        throw new Error("a secret value cannot contain a line break");
      const result = runner(
        "security",
        ["-i"],
        `add-generic-password -U -s ${quote(SERVICE)} -a ${quote(account(capability, name))} -w ${quote(value)}\n`,
      );
      if (result.status !== 0)
        throw new Error(`the keychain refused to store ${name}`);
    },
    remove(capability, name) {
      return (
        runner("security", [
          "delete-generic-password",
          "-s",
          SERVICE,
          "-a",
          account(capability, name),
        ]).status === 0
      );
    },
  };
}

// For tests and callers that pass values another way.
export function memoryStore(values: Record<string, string> = {}): SecretStore {
  return {
    name: "memory",
    get: (capability, name) => values[account(capability, name)],
    set: (capability, name, value) => {
      values[account(capability, name)] = value;
    },
    remove: (capability, name) => delete values[account(capability, name)],
  };
}
