# Providers

Ocean runs agents by shelling out to the provider's own CLI as a headless subprocess. It
does not call any provider API directly and does not store or manage provider credentials —
authentication is entirely the installed CLI's responsibility.

## Supported providers

`HeadlessProvider` (`src/infrastructure/providers/providers.ts`) is one of:

- `claude`
- `codex`
- `gemini`
- `antigravity`
- `hermes`
- `kilo`
- `kimi`

The private workspace may register additional clients for interactive interception. The registered providers
above are headless-capable through provider-specific invocation contracts; the executable smoke check verifies
that all seven command names are available, while authenticated execution still depends on each provider account.

## Requirement

The provider's CLI binary must be on `PATH`:

- `claude`, `codex`, `gemini` are invoked by their own command name.
- `antigravity` is invoked as `agy`.
- `hermes` is invoked by its own command name.
- `kilo` is invoked by its own command name.
- `kimi` is invoked by its own command name.

## Interactive limits

`ocean run` is the full-head path. A plain provider command runs natively and
reaches Ocean only through its own hooks. `ocean-<command>` enters through the
terminal shim with `observed` control: Ocean records the entry contract,
provider resolution, bounded output, terminal input when a TTY is available,
lifecycle, and evidence, but it does not claim provider-native policy control.

Context transport is provider-specific. Hermes currently receives a partial
environment hint; Claude's verified context injection is limited to print mode;
the other provider adapters are proven for headless prompt transport, not for
interactive context injection. `ocean client status` and `ocean session show`
expose the actual entry contract instead of treating every interactive CLI as a
full Ocean head.

If the binary is missing, the spawn fails at run time (surfaced as an `error` session
event); Ocean performs no live verification that a provider is installed or authenticated
before invoking it.

## Invocation shape (`buildProviderInvocation`)

`claude` is not in this table: it runs through the Claude Agent SDK (see
[Claude](#claude-through-the-agent-sdk)).

| Provider | Command | Args |
|---|---|---|
| `codex` | `codex` | `exec --json <prompt>` |
| `gemini` | `gemini` | `--prompt <prompt> --output-format stream-json` |
| `antigravity` | `agy` | `--print <prompt> --output-format stream-json` |
| `hermes` | `hermes` | `-z <prompt>` |
| `kilo` | `kilo` | `run --auto <prompt>` |
| `kimi` | `kimi` | `--prompt <prompt> --print --output-format stream-json` |

Only `claude` currently supports `--resume`; `resumeAgent` in
[sessions.md](sessions.md#cli-usage) rejects resume for any other provider.

## Execution (`runProvider` → `runHeadless`)

`runProvider` builds the invocation and calls `runHeadless`
(`src/infrastructure/process/cli-process.ts`), which:

- Spawns the command with `cwd` set to the agent's working directory and `stdio` set to
  ignore stdin, pipe stdout/stderr.
- Splits stdout into lines; each line is parsed as JSON if possible (emitted as a `"json"`
  event) or kept as raw text (emitted as a `"text"` event) and forwarded to `onEvent`.
- Applies a timeout (default 60,000 ms); on timeout the process is sent `SIGTERM` and the
  result reports exit code `124`.
- Resolves with `{ exitCode, events, stderr }` once the process closes.

### Claude through the Agent SDK

`runProvider` hands a `claude` request to `runClaudeSdk`
(`src/infrastructure/providers/claude-sdk.ts`), which runs it with the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`, pinned exactly). `claudeSdkOptions` maps the request onto
SDK options, and the SDK turns those into Claude Code's own flags and speaks its stream
protocol:

| Request | SDK option | Claude Code flag |
|---|---|---|
| `resumeId` | `resume` | `--resume` |
| `model` (unless provider-managed) | `model` | `--model` |
| `readOnly` | `permissionMode: "plan"`, `extraArgs.restricted` | `--permission-mode plan --restricted` |
| `readDirectories` | `additionalDirectories` | `--add-dir` (one per directory) |

The contract matches the other providers:

- **Executable:** the SDK runs the user's installed `claude`, resolved past Ocean's shims. The
  SDK's bundled platform binaries are excluded at install (`ignoredOptionalDependencies` in
  `pnpm-workspace.yaml`).
- **Process:** Ocean spawns it through `spawnClaudeCodeProcess`, so `onSpawn` gets its pid and
  its environment is this process's plus the plan's variables.
- **Events:** every SDK message becomes a `"json"` event.
- **Limits:** the run's timeout ends it with exit code `124`, and its output budget (messages
  and stderr together) with `125`.
- **Load cost:** the SDK loads only when Claude actually runs.

Provider-side session ids are captured opportunistically: if a `"json"` event's data
contains a `session_id` field, `agent-run.ts` stores it as the session's `providerSessionId`
for later resume.

`discoverProviderCapabilities()` checks whether the selected CLI is installed and returns its
headless, resume, streaming, structured-output, and CLI-managed authentication contract.
`assertProviderCapability()` fails clearly before an unsupported operation. One session uses
one selected provider; Ocean does not silently fall back to another provider.
