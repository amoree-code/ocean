# Ocean

**One workspace for every AI agent you use.** Ocean is a local-first layer that gives Claude,
Codex, Gemini, Qwen, Cursor, OpenCode and other AI clients the same projects, tasks, memory
and knowledge, on your machine, without a hosted service.

## Why

Every AI client keeps its own memory, its own history and its own idea of what you were doing.
Switch clients and the context is gone. Come back next week and the decisions are buried in a
chat log.

Ocean moves that state out of the clients and into one place you own. Projects, tasks,
decisions and sessions live as plain files in a private workspace on your disk. Every client
reads from and writes to that same workspace through one runtime. A task started in Claude can
be continued in Codex, reviewed in Gemini and closed from the terminal, with nothing explained
twice.

## What it does

- **Projects and tasks.** Each repository you work in maps to a project. Tasks are files that
  declare their own status, so any client can pick one up, checkpoint it and close it.
- **Shared memory.** Durable facts and lessons are curated markdown, indexed for full-text and
  vector search, and served to every client over MCP.
- **Bounded context.** A session gets a small packet of what the work needs, loaded in layers,
  instead of the whole workspace.
- **Client setup.** `ocean clients apply` adds Ocean's MCP server and session hooks to every
  installed AI client, and journals each change so it can be rolled back.
- **Session records.** Shims on your `PATH` record what each AI CLI did, so work can be
  reviewed and resumed.
- **Health checks.** `ocean doctor` reads the workspace, clients and integrations, and names
  the fix for anything broken.

## Principles

- **Local-first.** Records are files on your machine. No account, no server, works offline.
- **The record is the truth.** Boards and indexes are generated from the records and checked
  for drift, never hand-edited.
- **Provider-neutral.** No model is special. The workspace outlives any client.
- **Explicit authority.** Reads are free. Writes outside the workspace need an explicit flag.
- **Public engine, private data.** The engine holds code and templates only. Your records never
  enter it, and Ocean never stores provider credentials.

## Install

Requires Node.js 22.16 or newer, on macOS or Linux.

```bash
npm install --global @amoree-code/ocean
ocean setup
```

The same name is on npm and GitHub Packages. `ocean setup` creates the
private workspace at `~/ocean` (or `OCEAN_ROOT`), adds shims for the AI CLIs and starts a small
background service.

## Quick start

```bash
ocean clients plan               # which AI clients Ocean can connect, and what changes
ocean clients apply --yes        # connect them
cd ~/code/acme && ocean project register   # make this repository a project
ocean tasks new "Add login"      # open a task any client can continue
ocean doctor                     # check that everything is wired
```

## This repository

The repository mirrors `~/ocean/`. The engine in [`kernel/`](kernel/) is public and complete.
Every workspace folder ships as an empty `.gitkeep`: its files hold private data and never
leave the machine, and the root `.gitignore` is a whitelist so none can be committed by
accident.

```text
~/ocean/
├── 00-inbox/          intake waiting for triage
├── 01-daily/          daily summaries
├── 02-personal/       durable personal facts
├── 03-professional/   work documents
├── 04-projects/       projects, one folder per category
├── 05-knowledge/      reusable lessons and decisions
├── 06-templates/      templates for tasks, decisions and sessions
├── charter/           rules every AI client loads
├── bridge/            machine-local state: config, profiles, sessions, skills
└── kernel/            the engine: packages/, docs/, scripts/
```

Projects are grouped by who they belong to: `company/`, `personal/`, `freelance/`,
`former-company/`, `vendor/`, and `uncategorized/` for a new one.
`ocean project move <id> <category> --write` files a project.

## Documentation

- [Engine README](kernel/README.md): every command, MCP tools, agent skills, development
- [Architecture](kernel/docs/architecture.md) and [workspace layout](kernel/docs/workspace.md)
- [MCP](kernel/docs/mcp.md), [providers](kernel/docs/providers.md),
  [security](kernel/docs/security.md), [troubleshooting](kernel/docs/troubleshooting.md)
- [Changelog](kernel/CHANGELOG.md)

## License

MIT © AMEER ABDULKAREEM JABBAR LAMI
