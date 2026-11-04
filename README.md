# Ocean

**One workspace for every AI agent you use.** Ocean is a local-first layer that gives Claude,
Codex, Gemini, Qwen, Cursor, OpenCode and other AI clients the same projects, tasks, memory
and knowledge — on your machine, without a hosted service.

## The idea

Every AI client keeps its own memory, its own history, and its own idea of what you were
doing. Switch from one to another and the context is gone; come back next week and the
decisions are buried in a chat log nobody will reread.

Ocean moves that state out of the clients and into one place you own. Projects, tasks,
decisions, sessions, and evidence live as plain files in a private workspace on your disk.
Every client — whichever model, whichever vendor — reads from and writes to that same
workspace through one runtime. The client becomes the hands; Ocean is the memory and the
rules.

Like an ocean connects every shore, Ocean connects every agent to the same body of work: a
task started in Claude can be continued in Codex, reviewed in Gemini, and closed from the
terminal, with nothing re-explained.

## Philosophy

- **Local-first.** Your records are files on your machine. No account, no server, no sync
  service in the middle. Ocean works offline and never needs to phone home.
- **The record is the truth.** A task declares its own status in its own file. Boards,
  indexes, and summaries are generated from the records and checked for drift — never
  hand-edited, never authoritative.
- **Storage is not context.** An agent receives a small, bounded packet of what the work
  needs, loaded in layers, not the whole workspace. Less noise, lower cost, better answers.
- **Provider-neutral.** No model is special. Providers are entry points that can be added,
  swapped, or removed; the workspace outlives any of them.
- **Explicit authority.** Reads are free. Writes outside the workspace, promotions and
  installs show a preview and need an explicit flag (`--yes`, `--apply`, `--approve`).
  Nothing is promoted or published implicitly.
- **Verified, not claimed.** A provider saying "done" is not evidence. Completion is an
  independent check passing, and the result records what was verified versus assumed.
- **Public engine, private life.** The engine holds code, tests, and templates only. Your
  records, governance, and machine state live in a separate private workspace and never
  enter it. Ocean never stores provider credentials.

## Requirements

- **Node.js 22.16 or newer** (Ocean uses the built-in `node:sqlite`).
- macOS or Linux. Windows runs the engine and its tests; the layout move and some
  integrations are untested there.
- On Linux, recording a provider's terminal session needs `node-pty`, which has no Linux
  prebuild: npm compiles it when `python3`, `make` and a C++ compiler are present
  (`sudo apt install -y python3 make g++`) and skips it otherwise. Ocean installs and runs either
  way; without it, providers run attached to your terminal and their output is not recorded.
- The AI clients you want to connect, installed and signed in the usual way. Ocean does not
  install credentials and does not need an API key of its own.

## Install

```bash
npm install --global @ameer.abdulkareem/ocean
ocean setup
```

The npm package is `@ameer.abdulkareem/ocean` (the name `ocean` belongs to another project); the
command is `ocean`.

**Release status:** the npm package is prepared but not yet published. Until it is, install
from a checkout (see [Development](#development)) or from a tarball built with
`pnpm release:pack` ([release guide](docs/release.md)).

`ocean setup` creates the private workspace and connects your shell:

- the workspace at **`~/ocean`** — or the directory in `OCEAN_ROOT`, if set;
- shims for the AI CLIs on your `PATH`, so their sessions are recorded;
- a line in your shell profile (`~/.zshrc`, `~/.bashrc` or the fish config);
- a login service (a LaunchAgent on macOS, a systemd user unit on Linux, a startup script on
  Windows) that keeps the local runtime running.

It never writes inside the installed package. `ocean setup --help` shows its options. Running
`ocean` with no command starts a short first-run guide; `ocean onboard --status` shows its
steps without running them.

## First useful workflow

```bash
ocean clients plan              # which installed AI clients Ocean can connect, and what changes
ocean clients apply --yes       # add Ocean's MCP server and session hooks to them (journaled)
ocean doctor                    # read-only health check; FAIL lines name the fix
```

Make a folder an Ocean project, then work in it from any connected client or the terminal:

```bash
cd ~/code/acme
ocean project bind acme "$PWD"  # this folder is the project "acme" (records in ~/ocean/04-projects/acme)
ocean context                   # what Ocean knows here: project, memory, active tasks
ocean tasks new "Ship the login page"
ocean memory reindex            # build the search index (the background service keeps it current)
ocean memory search "login"
```

A connected client opened in that folder starts with a bounded Ocean context line, can search
and read your records over MCP, and proposes facts worth keeping. `ocean memory review`
approves or rejects them; `ocean clients restore` undoes the last `clients apply`.

## Commands

`ocean --help` lists every command; `ocean <command> --help` (or `-h`, anywhere before `--`)
prints its usage and never runs it. To hand `--help` to a wrapped client, put it after `--`:
`ocean client open claude -- --help`. **Reads** only reads. **Writes** changes the workspace, or files outside it where noted.
**Runs** starts a process: an agent, a provider CLI, a browser, a server or an installer.
**Approval** is the flag a command needs before it acts; without it, the command previews.

| Command | What it does | Kind |
| --- | --- | --- |
| `ocean setup` | create the workspace, shims, shell line and login service | Writes (also outside: shell profile, login service) |
| `ocean onboard` | run the pending first-run steps | Writes; `--status` reads |
| `ocean context` | the workspace context for this folder; `cost` measures each client's always-on context | Reads |
| `ocean project` | resolve, bind, register, rename and index projects | Reads; `bind`, `register`, `rename`, `unbind`, `--write` write |
| `ocean tasks` | list, create, claim, checkpoint, verify and complete tasks | Reads; `new`, `claim`, `checkpoint`, `complete`, `archive --apply` write |
| `ocean loop` | repeated agent runs on one task | Runs; `start` needs `--approve` |
| `ocean policy` | list the charter's policies or print one | Reads |
| `ocean lifecycle` | decide whether work should checkpoint now | Reads |
| `ocean doctor` | health check of workspace, clients and integrations | Reads |
| `ocean repair` | what `doctor` can fix | Reads; `--apply` writes |
| `ocean run` | run a headless agent with a profile | Runs |
| `ocean profiles` | validate, upgrade or suggest agent profiles | Reads; `upgrade --apply` writes |
| `ocean session` | list, show, resume, promote and compact sessions | Reads; `resume` runs; `promote` needs `--approve`; `compact --apply` writes |
| `ocean service` | the background runtime (the login service starts it) | Runs |
| `ocean intercept` | run an AI CLI with session capture (the shims call it) | Runs |
| `ocean operate` | classify a plain-language request and run the matching operation | Runs |
| `ocean intent` | classify a plain-language request | Reads |
| `ocean gateway` | local webhook gateway on 127.0.0.1 (needs `OCEAN_GATEWAY_TOKEN`) | Runs |
| `ocean schedule` | scheduled agent runs | Writes; `run-now`, `worker` run |
| `ocean client` | inspect, open, register and sync AI clients | Reads; `open` runs; `sync`, `register`, `enable`, `disable` write |
| `ocean clients` | connect installed AI clients to Ocean | Reads; `apply` needs `--yes` and writes client config outside the workspace |
| `ocean install` / `update` / `remove` | install, update or remove an AI client CLI | Runs an installer; needs `--yes` |
| `ocean auth` | show or start an AI client's login | Reads; `login` runs |
| `ocean mcp` | print MCP client configs, or serve Ocean's MCP server and gateway | Reads; `serve`, `gateway` run; `browser-service install` writes outside |
| `ocean market` | marketplace skills and MCP servers | Reads; `install`, `update`, `uninstall` write; `exec` runs; permissions need `--yes` |
| `ocean browser` | drive a browser session | Runs; `upload`, `submit` need `--approve` |
| `ocean memory` | search, read, review and maintain memory | Reads; `approve`, `delete`, `restore`, `reindex`, `sync --apply`, `purge --yes` write |
| `ocean pull` | pull what AI clients hold into Ocean as review candidates | Reads (dry run); `--yes` writes |
| `ocean observe` | run a command and record its output | Runs |
| `ocean capture` / `idea` | capture ideas, then promote or discard them | Writes |
| `ocean handoff` | hand work from one session or client to another | Reads; `create` writes |
| `ocean daily` | prepare today's note | Reads; `--apply` writes |
| `ocean skill` | sync, add, review and learn skills | Reads; `add`, `review`, `learn`, `sync` write |
| `ocean catalog` | the AI clients Ocean can install | Reads |
| `ocean obsidian` | connect, sync and write to an Obsidian vault | Writes; vault writes need `--read-write` and `--apply` |
| `ocean hook` | session hooks the AI clients call | Writes session records |
| `ocean migrate` | migrate the session store | Reads (dry run); `--apply` writes |
| `ocean layout` | move the workspace to the current layout | Reads (`plan`); `apply --yes`, `rollback --yes` write outside |
| `ocean env` | print the shell line that puts the shims on `PATH` | Reads |

No `ocean` command publishes anything. Publishing the engine (`scripts/publish.mjs`) and the
npm package are maintainer steps, each with its own confirmation ([publishing](docs/publishing.md),
[release](docs/release.md)).

## MCP

`ocean clients apply --yes` adds Ocean's MCP server to each supported client; `ocean mcp
config` prints the entry for a client you configure by hand. The server is local `stdio`
only and receives no provider credentials. It offers:

- **reads** — `brain_search`, `brain_read`, `brain_neighbors`, `memory_read`,
  `memory_history`, tasks, sessions, handoffs, projects, profiles, `ocean_context`,
  `ocean_status` and `ocean_doctor`;
- **writes** — `memory_write` (only when you ask a client to remember or change something;
  an update must name the record's current hash), `memory_propose` (a candidate for your
  review), `memory_delete` (soft, undone by `memory_restore`), `ocean_handoff_create`, and
  `ocean_session_promote`.

Every call is logged as `{ts, client, tool, ok}` only — never the question or the content —
in `bridge/state/mcp/calls.jsonl`; `ocean clients ledger` summarizes it. See [MCP](docs/mcp.md).

## Agent skills

Ocean ships provider-neutral Agent Skills under `packages/harness/skills/core/`, invoked
by name from any registered client. The core loop:

- `catch-up` — reconstruct project state, completed work, blockers, and the next action.
- `core-thinking` — separate facts from assumptions and choose the smallest valid
  solution before executing.
- `verification` — turn an implementation claim into a focused, repeatable check.
- `session-handoff` — produce a compact continuation packet for the next session.

Alongside them: `business-logic`, `design-thinking`, `graft`, `loop`, and `use-browser`.
See [skills/index.json](packages/harness/skills/index.json) for the current catalog.
`ocean skill learn <completed-session-id>` extracts a candidate skill from a finished
session, and `ocean skill review <candidate-id> promoted` activates it.

## Public engine, private workspace, machine state

```text
~/ocean/                        private workspace (OCEAN_ROOT) — local only, never published
├── 00-inbox/ … 06-templates/   your records: inbox, daily, personal, professional,
│                               projects, knowledge, templates
├── charter/                    your rules and the policies they route to
└── bridge/                     machine state: sessions, config, client integrations, shims

<npm prefix>/lib/node_modules/@ameer.abdulkareem/ocean/
                                the engine: code, the empty workspace template, skills
```

Three things are kept apart:

- **The engine** is public and read-only at runtime. It holds no record of yours.
- **The private workspace** holds everything that is yours. `ocean setup` seeds it from an
  empty template; nothing in it is ever copied back into the engine.
- **Machine state** (`bridge/`) is specific to one computer: sessions, client wiring, shims.

Two release gates enforce the boundary. The npm tarball is built by `pnpm release:pack`,
which refuses any workspace folder, machine-local config, credential file, source, test or
source map, any template file beyond its approved empty placeholders, and anything the
privacy scan flags (home paths, e-mail addresses, credential shapes). The source export
(`scripts/publish.mjs`) uses the same deny list. See [Security](docs/security.md).

## Security

- Ocean never stores provider credentials; each client keeps its own login.
- `bridge/` is created owner-only. Secrets do not belong in any Ocean file.
- Text Ocean keeps from a session — summaries, promoted results, handoffs — passes through
  redaction of secret shapes and your home-directory paths first.
- The MCP server is local `stdio` only; nothing listens on the network unless you start
  `ocean gateway` (127.0.0.1, token required).

See [Security](docs/security.md) for the workspace boundary and access control.

## Troubleshooting

- **`ocean: command not found` after install** — npm's global `bin` is not on `PATH`:
  `npm prefix --global` shows the prefix; add its `bin` to `PATH`.
- **`EBADENGINE`, `No such built-in module: node:sqlite` or `does not provide an export named
  'backup'`** — Node is older than 22.16;
  upgrade it and reinstall.
- **The workspace is in the wrong place** — set `OCEAN_ROOT` and run `ocean setup` again.
- **A client does not see Ocean** — run `ocean doctor`, then `ocean clients apply --yes`,
  and restart the client.

More in [Troubleshooting](docs/troubleshooting.md).

## Development

```bash
git clone https://github.com/amoree-code/ocean.git ~/ocean/kernel
cd ~/ocean/kernel
pnpm install
pnpm build
node packages/harness/dist/main.js setup
pnpm test
pnpm check
```

A checkout inside a workspace (`~/ocean/kernel`) serves that workspace (`~/ocean`); elsewhere
it uses `~/ocean` like an installed package. The test suite uses temporary workspaces and
SQLite databases; it never invokes a real provider or needs an API key. `docker build -t
ocean-test . && docker run --rm ocean-test` runs it in an isolated image.

Ocean is versioned as one unit; every package shares the version in its `package.json`.
Every pull request adds a line under **Unreleased** in the [changelog](CHANGELOG.md).

## Documentation

- [Operating model](docs/operating-model.md) — ownership, request flow, and the provider boundary
- [Architecture](docs/architecture.md) — packages, layers, and the public/private boundary
- [Workspace](docs/workspace.md) — layout, path resolution, and `ocean setup`
- [Entry points](docs/entry-points.md) — `ocean run`, the shims and the managed PTY
- [Profiles](docs/profiles.md) — schema, loading, and the default profile
- [Sessions](docs/sessions.md) — storage, status lifecycle, and CLI usage
- [Providers](docs/providers.md) — supported providers and how they are invoked
- [Context](docs/context.md) — how the prompt context is assembled and bounded
- [MCP](docs/mcp.md) — the MCP servers, client wiring and the gateway
- [Browser](docs/browser.md) — the browser capability and its approvals
- [Security](docs/security.md) — credentials, the workspace boundary, and access control
- [Publishing](docs/publishing.md) — how the public source export is checked and pushed
- [Release](docs/release.md) — building, checking and publishing the npm package
- [Troubleshooting](docs/troubleshooting.md) — common errors and how to resolve them
- [Migration](docs/migration.md) — what changes between versions and how to move a workspace
- [Changelog](CHANGELOG.md) — what changed, per release

## License

Ocean is open source under the [MIT License](LICENSE).
