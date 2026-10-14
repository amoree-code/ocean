# Security

## Credentials

Ocean never stores, reads, or manages provider credentials. Authentication is delegated
entirely to each provider's own CLI (`claude`, `codex`, `gemini`, `agy`, `hermes`) — Ocean only spawns
that binary and streams its stdout/stderr (see [providers.md](providers.md)). Before any of
that stdout/stderr is persisted, `redactSecrets()`
(`src/infrastructure/observability/runtime-logger.ts`) strips known credential shapes
(vendor API key prefixes, bearer tokens, JWTs, PEM keys, connection strings, webhook URLs)
plus a high-entropy-token fallback for unrecognized secrets. This is pattern- and
entropy-based, best-effort redaction, not a filesystem-level or cryptographic guarantee — a
credential shaped like ordinary low-entropy text could still slip through.

## Public engine / private workspace boundary

This repository contains no user data. All user and technical state lives in a private
workspace outside of `engine/` (see [workspace.md](workspace.md)), which:

- Is not part of this repository's git history.
- Is git-ignored by this repository's `.gitignore` as a safety net (`personal/*`,
  `projects/*`, and `system/*`) even if a workspace is ever accidentally nested inside a clone.
- Is created by `ocean setup` with `config` restricted to `0700` permissions.

## Filesystem access

Profiles declare `allowedPaths`, and a headless prompt only references a `contextSources`
entry or a context-packet record if its realpath resolves inside one of those paths; a symlink
escaping them is omitted. The context packet is used only for an exact task-id lookup, never
for keyword-triggered memory, knowledge or decision lookups. Ocean reads no context body into
the prompt (see [context.md](context.md)). Skill folders, the facts store directory (only when the
facts digest is partial) and reference directories that themselves lie inside `allowedPaths` are
granted to Claude (`--add-dir`) and Gemini (`--include-directories`) for reading only, on the
first turn and again on a resumed Claude turn; a single-file `allowedPaths` entry never grants its
siblings. The schema also
carries `allowedCommands` and `writePolicy` per profile (see [profiles.md](profiles.md));
the run boundary rejects an unauthorized provider command and an empty `allowed-paths`
policy. Direct interception keeps provider-owned execution behavior. Ocean does not currently
provide an enforcing filesystem sandbox, so writable profiles fail closed. Ocean does not copy
or invent credentials; authentication remains owned by each provider CLI.

## Data validation

Before publication, run `pnpm check:privacy`. This read-only release-gate scan checks tracked
and publishable untracked source, documentation, and templates for credential patterns, real
private paths, and personal data. It reports finding types and file paths without secret values
and fails closed; Git-ignored machine-local files, license text, dependencies, and build output
are intentionally ignored.

Profiles, sessions, and context manifests are all validated against Zod schemas on read and
write (`profile-validator.ts`, `session-validator.ts`, `context-validator.ts`), so malformed
state fails fast rather than propagating silently.

## Session status integrity

Session status transitions are enforced by `assertValidStatusTransition`
(`src/domain/sessions/session.ts`): a session can only move along the documented
lifecycle (see [sessions.md](sessions.md#status-lifecycle)); `cancelled` is terminal.

## Installation and bypass boundaries

`ocean install` uses only cataloged package-manager recipes and requires `--yes`. Unknown
clients and arbitrary URLs are rejected. `ocean update` repeats the approved recipe; `ocean
remove` removes only Ocean registration, wrappers, and receipts. Provider binaries, user data,
and provider-owned credentials remain outside Ocean ownership.

Native desktop clients, absolute-path launches, unconfigured shells, and operating-system
processes outside the managed shim remain explicit bypass boundaries; a plain provider
command is one of them unless its native hook is registered. Ocean reports these when
detectable; it does not claim universal interception.

Gateway credentials support an identity and optional profile scope using the environment-only
format `id@profile-a|profile-b=token`; an unscoped `token` remains the default identity. Each
gateway request includes an approval fingerprint over its exact profile and prompt, and the
resulting session records the gateway identity. MCP writes and promotions use the same
action-bound approval model. These bindings constrain the request; they do not replace provider
authentication.
