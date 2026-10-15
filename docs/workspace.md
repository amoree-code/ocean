# Workspace

Ocean separates the public **engine** (`kernel/` in this repository) from a private
**workspace** (`~/ocean`) that holds every piece of user and runtime data. `kernel/` is
`~/ocean`'s own git repository with its own remote — the workspace root above it is a
separate, private, no-remote repository (see `git.md`'s policy for the boundary).
The workspace root holds the user-owned records (PARA areas `00-inbox/` … `06-templates/`),
the `charter/`, and `bridge/` — machine-local state with no git at all. None of it lives inside
this repository. (Before T-243 the records sat under `brain/` and the bridge under `kernel/bridge/`;
the engine still reads that layout, see below.)

## Layout

```text
<workspace root>/           default: the parent directory of kernel/ (e.g. ~/ocean)
├── 00-inbox/ … 06-templates/   user-owned private data (PARA)
│   └── 04-projects/         project data (registry, backlog, per-project tasks)
├── charter/                 private governance: core.md, policies/
├── kernel/                  this repository
└── bridge/                  machine-local state, no git
    ├── profiles/            one JSON file per profile (see profiles.md)
    ├── sessions/
    │   └── sessions.sqlite  session store (see sessions.md)
    ├── config/
    │   ├── startup/
    │   └── CONFIG.md
    ├── registry/            machine-local provider, install and project registry
    ├── integrations/        private client integrations
    └── archive/             private retained legacy history
```

## Root resolution (`src/paths.ts`)

- `engineRoot()` / `enginePath(...)` — always the directory containing this package
  (resolved from the running module, whether compiled under `dist/` or run under `tsx`
  from `src/`).
- `oceanRoot()` — `OCEAN_ROOT` if set (resolved to an absolute path),
  otherwise three directories above `engineRoot()` (`kernel/packages/harness` → the workspace root). This is the default private-workspace
  location: `kernel/` is expected to sit inside the workspace root as a sibling of `bridge/`.
- `oceanPath(...)` — joins onto `<oceanRoot>/`, used for all private workspace state, via
  the `PERSONAL_DIR`/`PROJECTS_DIR`/`SYSTEM_DIR` constants (`02-personal`, `04-projects`,
  `bridge`). Each half of the layout is chosen once per process by a sentinel directory: the
  records use `04-projects/` and fall back to `brain/04-projects/`; the bridge uses
  `bridge/sessions/` and falls back to `kernel/bridge/sessions/`. A process started before a
  layout move keeps the old layout until it restarts. `ocean layout plan | apply --yes |
  rollback --yes` performs the move (macOS and Linux).

Set `OCEAN_ROOT` to point Ocean at a different workspace root, for example to run multiple
isolated workspaces from one engine checkout.

## Bootstrap (`ocean setup`)

`src/interfaces/cli/setup-command.ts` creates the workspace on first run (paths below via
the same three constants, so they track any future layout change):

- Creates `02-personal`, `05-knowledge`, `01-daily`, `00-inbox`,
  `06-templates`, and the workspace project's `04-projects/ocean/tasks`
  under the workspace root.
- Creates `bridge/config/startup`, `bridge/profiles`, `bridge/sessions`, `bridge/registry`,
  `bridge/integrations`, `bridge/archive` and `bridge/runtime/{shims,temporary}` under the
  workspace root.
- Writes `bridge/profiles/default.json` from the template in `packages/harness/templates/`,
  without overwriting existing files.
- Installs a per-OS startup entry that launches `kernel/packages/harness/dist/main.js service`
  with the workspace root as its working directory: a macOS `launchd` plist under
  `~/Library/LaunchAgents`, a Linux `systemd --user` unit under
  `~/.config/systemd/user`, or a Windows Startup-folder launcher script.
- Restricts the private `bridge` tree to `0700` permissions.

Startup always points at `kernel/packages/harness/dist/main.js` (the built engine), never at
`src/`, and always runs with the private workspace directory as its current working
directory.

## Task completion and archive

Use the governed completion command when a task is genuinely finished:

```bash
ocean tasks complete T-123
```

It requires every checklist item to be checked, writes `state: done`, and moves the
whole task directory (including sibling artifacts) into `04-projects/ocean/tasks/archive/Ocean/`
in one operation. Read-only commands such as `ocean tasks list` do not mutate files.

Tasks that were marked `done` by an external editor can be reconciled explicitly:

```bash
ocean tasks archive --auto
```

There is no background filesystem watcher; this keeps completion deterministic and avoids
making a read-only inspection command silently move user data.

## Skills

There is one live skills store: `bridge/skills` (machine-local, git-ignored). `packages/harness/skills` is
only the set of core skills shipped with the engine; `ocean skill hub` copies it, plus any extra folders
you name, into the store (additive, never overwrites).

`ocean skill copy` is how clients get skills (T-244: one home, clients get copies, not symlinks): it
gives `claude`, `codex` and `gemini` a real copy of every hub skill, whole directories included. It is a
dry run until `--apply`; a link into the hub is just unlinked, any other link or a differing real
directory is moved into a timestamped backup under `bridge/archive/`, and a skill that contains a
symlink is reported as `failed` instead of copied. Entries the hub does not name are left alone.
`ocean onboard` runs this as the `skills` step.

`ocean skill link` is the older symlink-based alternative it replaced: it shows the plan and
`ocean skill link --apply` makes the links, backing up each replaced copy under `bridge/archive/`.
Skills a client does not already have are only linked with `--all`, because every skill adds always-on
context. Onboarding no longer runs this.
