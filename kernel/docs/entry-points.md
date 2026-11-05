# Ocean entry-point contract

Ocean has one full-head execution path and several compatibility boundaries. The
entry point is part of the session evidence; command resolution alone is not proof
of full governance.

## Entry points

### `ocean run`

This is the canonical `full-head` path. Ocean owns the profile, bounded context,
skills, policy, approval contract, session, provider adapter, output events,
evidence, and explicit capture/promotion boundary.

```text
ocean run
  -> profile and policy
  -> bounded context and provider adapter
  -> provider process
  -> session events and evidence
  -> explicit capture or promotion
```

### Native hooks and the `ocean-<command>` wrapper

A plain `claude`, `codex`, `gemini`, `agy`, `hermes`, `kilo`, or `kimi` command
runs the provider's own binary. Ocean never installs a shim under a provider's
own name: a same-name shim only works while its directory is first on `PATH`,
so the same command behaved differently per shell. Clients reach Ocean through
their native hooks instead (`ocean hook session-start --client claude|codex|hermes`).

`ocean setup` installs an `ocean-<command>` wrapper per registered provider
(`ocean-claude`, `ocean-codex`, ...). Running it enters `terminal-shim` with
`observed` control. The wrapper records its entry contract, provider resolution, authentication state,
bounded provider output, terminal input when a TTY is available, lifecycle, and
evidence. It does not claim to own provider-native policy or to provide semantic
conversation capture for raw terminal bytes.

Inspect the boundary with:

```bash
ocean client status
ocean client doctor
ocean client doctor /absolute/path/to/native/provider
ocean session show <session-id>
ocean session events <session-id>
```

### Managed interactive session

This is the target `managed-partial` boundary for provider-native interactive
adapters. It must preserve terminal behavior while making input capture,
context transport, approvals, and limitations explicit per provider. It is not
complete merely because a PTY starts successfully.

Start the managed boundary explicitly with:

```bash
ocean client open hermes
ocean client open claude
```

The command owns the PTY and records a `managed-partial` entry contract. The
provider still owns its native authentication and UI behavior; provider-specific
context injection and semantic prompt capture remain capability claims that must
be proven separately.

Every governed entry point runs the shared session closeout when the provider exits. The closeout
writes a bounded human-readable summary under `bridge/sessions/summaries/`, stores only essential
summary metadata in `bridge/sessions/sessions.sqlite`, and may create a bounded handoff draft.
It does not automatically promote conversation content to memory, knowledge, inbox, daily files,
or skills.

### Desktop wrapper

Desktop clients may launch a provider by absolute path and bypass `PATH`. A
desktop integration is governed only when its supported wrapper setting points to
an Ocean shim and a real process inspection verifies the result. Otherwise the
session is `bypass` or `not proven`.

Passing an observed native path to `ocean client doctor` reports the bypass
explicitly; it does not rewrite client configuration or credentials.

## Session contract

Each governed provider session records a `session_entry_contract` event containing:

- `entryPoint`: `ocean-run`, `terminal-shim`, `interactive-managed`, or `desktop-wrapper`.
- `controlLevel`: `full-head`, `managed-partial`, `observed`, or `bypass`.
- `inputCapture`: `semantic`, `bounded-terminal`, or `none`.
- `contextTransport`: the provider-native or environment transport actually used.
- `policyEnforcement`: the policy boundary actually enforced.
- `promotion`: always `explicit-review`; no conversation is promoted automatically.
- `resume`: provider-native resume support or an explicit unsupported result.

## Data ownership

Runtime sessions and bounded events live in the private Ocean session store.
Provider credentials remain provider-owned. Session summaries are not knowledge.
Captures, knowledge, projects, tasks, Obsidian notes, browser actions, and
schedules require their own explicit operation and approval boundary.

## Status language

- `PROVEN`: the exact entry path and behavior were exercised and evidence persisted.
- `NOT PROVEN`: the path exists but the required real behavior was not exercised.
- `BLOCKED BY CLIENT LIMITATION`: the provider account, model, subscription, or native client blocked proof.
- `BYPASS`: the process was launched outside the managed Ocean boundary.
