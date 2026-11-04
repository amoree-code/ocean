# Troubleshooting

## Installing with npm

- **`ocean: command not found`** — npm's global `bin` directory is not on `PATH`.
  `npm prefix --global` prints the prefix; add `<prefix>/bin` to `PATH`.
- **`EBADENGINE`, `No such built-in module: node:sqlite`, or `does not provide an export named
  'backup'`** — Node is older than 22.16.
  Upgrade Node, then install again.
- **`ocean: node-pty is not installed, so this session's terminal output is not recorded`**
  (Linux) — npm skipped the optional `node-pty`: it has no Linux prebuild and the machine had no
  compiler toolchain. Install one (`sudo apt install -y python3 make g++`, or your
  distribution's equivalent), then run `npm install --global @amoree-code/ocean` again.
- **A provider opened through Ocean fails with `posix_spawnp failed`** (macOS) — node-pty's
  `spawn-helper` is not executable. Ocean sets the bit before the first terminal spawn; when the
  global prefix belongs to another user (an install with `sudo`), it cannot. Run
  `chmod +x "$(npm root --global)/@amoree-code/ocean/node_modules/node-pty/prebuilds/"*/spawn-helper`,
  or install into a prefix you own.

## `ocean run` prints `Usage: ocean run --profile <name> [--client <client>] [--task <id>] [--handoff <id>] --prompt <text>`

Both `--profile` and `--prompt` are required. `--prompt` consumes every argument after it
as the prompt text (`src/main.ts`), so pass it last.

## Profile load fails

`loadProfile` reads `<workspace>/bridge/profiles/<name>.json` and validates it with Zod
(see [profiles.md](profiles.md)). Failures mean either the file does not exist (run
`ocean setup` to create `bridge/profiles/default.json`, or add the named profile yourself)
or it does not match the schema — check `provider` is one of `claude`/`codex`/`gemini`/`antigravity`/
`hermes` and every required field is present.

## Session resume rejected: "Provider does not support resume yet"

`resumeAgent` only supports sessions whose `provider` is `claude` and that already recorded
a `providerSessionId` from a prior run (see [sessions.md](sessions.md#cli-usage)). Check
`ocean session show <id>` — if `providerSessionId` is `null`, the original run never
reported one (the provider's stdout never emitted a `session_id` field), and that session
cannot be resumed.

## Provider process fails immediately or times out

- Confirm the provider CLI is installed and on `PATH`: `claude`, `codex`, `gemini`, `hermes`, or
  `agy` for `antigravity` (see [providers.md](providers.md)). Ocean does not verify this
  before spawning.
- Confirm the provider CLI is authenticated on its own terms — Ocean does not manage or
  check credentials.
- The default subprocess timeout is 60,000 ms; a run that legitimately needs longer will be
  killed with `SIGTERM` and reported as exit code `124`. Inspect
  `ocean session show <id>` and its events for the `process_exit` payload.

## Workspace ends up in the wrong place

Without `OCEAN_ROOT`, an installed `ocean` uses `~/ocean`, and a checkout at
`~/ocean/kernel` uses the workspace around it (see [workspace.md](workspace.md)). Set
`OCEAN_ROOT` to use another location, then re-run `ocean setup` to bootstrap it.

## Private workspace directories show up in `git status`

They should not — this repository's `.gitignore` excludes the workspace's top-level folders
(`00-inbox/` … `06-templates/`, `charter/`, `bridge/`, `sessions/`) at its root (see
[security.md](security.md)). If they appear, the workspace root may have
been accidentally created inside `engine/`; check `OCEAN_ROOT` and the location `ocean
setup` reported.
