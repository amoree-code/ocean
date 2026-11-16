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

Every path to a project goes through `projectDir` / `listProjectDirs` in
`packages/core/src/shared/paths.ts`, which also read a project still flat at `04-projects/<id>/`;
`ocean project move <id> <category> --write` files one and rewrites the workspace paths that
named its old folder (T-311).

```text
<workspace root>/           default: the parent directory of kernel/ (e.g. ~/ocean)
├── 00-inbox/ … 06-templates/   user-owned private data (PARA)
│   └── 04-projects/         project data: registry, backlog, and each project in its
│                            category folder, <category>/<id>/ (company, personal,
│                            freelance, former-company, vendor; new ones in uncategorized/)
├── 07-notes/                your own notes: agents read and index them (ranked above what
│                            agents wrote), never write there (PROTECTED)
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

## Root resolution (`packages/core/src/shared/paths.ts`)

- `engineRoot()` / `enginePath(...)` — always the `ocean` package root
  (`packages/harness`). The CLI registers it at startup from its own location
  (`packages/harness/src/engine-root.ts`, under `dist/` or `tsx` from `src/`); a process
  that never loaded the CLI entry, such as a test, falls back to the workspace sibling
  `packages/harness`.
- `oceanRoot()` — in order: `OCEAN_ROOT` if set (resolved to an absolute path); the directory
  three above `engineRoot()` when it already holds a workspace (`04-projects/`,
  `brain/04-projects/`, `bridge/sessions/` or `kernel/bridge/sessions/`), which is a dev checkout
  at `~/ocean/kernel`; otherwise `~/ocean`, which is where a global npm install puts it.
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
  `06-templates`, `07-notes`, and the workspace project's `04-projects/personal/ocean/tasks`
  under the workspace root.
- Creates `bridge/config/startup`, `bridge/profiles`, `bridge/sessions`, `bridge/registry`,
  `bridge/integrations`, `bridge/archive` and `bridge/runtime/{shims,temporary}` under the
  workspace root.
- Copies the workspace template (`packages/harness/templates/workspace/`, T-296): the generic
  `charter/core.md` and `charter/policies/`, `06-templates/`, `bridge/config/`, the index files
  (`02-personal/MEMORY.md`, `05-knowledge/KNOWLEDGE.md`, `04-projects/PROJECTS.md`,
  `00-inbox/INBOX.md`), empty private files with placeholders only, and the required empty
  directories (`00-inbox/candidates`, `00-inbox/native`, `04-projects/_template/…`). A file that
  already exists is never replaced.
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

### The template and its purity check

Every template file has a class in `templates/workspace/MANIFEST.json`: `default` (generic
operational content), `private-empty` (headings, comments and `<placeholder>` tokens only) or
`keep` (an empty `.gitkeep`). `pnpm check:template` (`scripts/check-template-purity.mjs`, run in
CI and as a publish gate) proves each file matches its class, that the manifest and the tree
agree, and that no file holds an e-mail address, a home path, a phone number or a credential
shape. The `.gitkeep` files only keep empty directories in git; they provide no privacy.

Owner mode, local only: `node scripts/check-template-purity.mjs --private ~/ocean` also rejects
any term from `charter/policies/privacy-terms.txt` and any run of 12 words shared with the
workspace's private records (`01-daily`, `02-personal`, `03-professional`, `04-projects`,
`05-knowledge`, `sessions`), ignoring runs that also stand in the policies, templates or config.
It prints `{file, line, rule}` only, never the matched text. Run it before publishing a change to
the template.

## Capture and templates (T-314)

Every record type with one home is named in `packages/brain/src/memory/routing.json`
(`records`); `ocean doctor` reports `TYPE_LOCATION` and `FRONTMATTER_MISSING` against it.

- `ocean note "<text>"` writes `00-inbox/captures/<time>-<slug>.md` with `type: capture`
  frontmatter (secrets redacted).
- From anywhere else, an Obsidian URI does the same through the app:
  `obsidian://new?vault=<vault>&file=00-inbox/captures/<name>&content=<text>` — bind it to a
  macOS Shortcut, a Raycast quicklink or a QuickAdd capture choice.
- `ocean obsidian templates [--yes]` writes Templater's folder templates from the table, so a
  note created in a type's folder starts from `06-templates/<type>.md`; entries for other
  folders are kept, and a type without a template is listed as `missing`.

People live one per file in `02-personal/people/` (`type: person`, `aliases` in every spelling
you use, English and Arabic). The `people_lookup` MCP tool matches a name exactly — file name,
title or alias — and `02-personal/people/people.base` lists them in Obsidian. Record
work-relevant facts only; nothing sensitive about other people.

Interests live one per file in `02-personal/interests/` (`type: interest`, `priority`,
`keywords`, `sources`). A source is an `https://` RSS/Atom feed or `github:<owner>/<repo>` (its
releases). `ocean brief` writes `01-daily/briefs/<date>.md`: high-priority interests, five
items at most, newest first; `--weekly` takes every interest, fifteen at most. A general feed
is narrowed by the interest's keywords; a releases feed is taken whole. A seen-ledger in
`bridge/state/brief/` keeps an item from coming back; a source that fails is listed, not fatal.

`ocean interests discover [--yes]` reads the `package.json` of every registered project and
maps known packages (`packages/services/src/brief/source-registry.json`) to their release
feeds; each topic without an interest file becomes a review candidate (`origin: discovered`),
never a file. `ocean interests keep|skip <name>` moves an interest's weight (and `keep` its
`last_signal`); `ocean interests decay [--weeks N] [--yes]` lowers a discovered interest with
no signal for 8 weeks. An interest you wrote yourself is never decayed.

Every finished session writes one record to `01-daily/sessions/YYYY-MM/` (`type: session`,
project, provider, status, session_id, date, `distilled: false`; sections Goal, Outcome,
Decisions, Problems → fixes, Learned, Verification, Files / commits, Next). The narrative comes
from one cheap model call when available, else from the session's events; trivial sessions are
skipped. `ocean memory migrate-sessions [--yes]` moves older `00-inbox/brain-dump/` files there.

## Task completion and archive



Use the governed completion command when a task is genuinely finished:

```bash
ocean tasks complete T-123
```

It requires every `Definition of done` criterion to be an explicitly checked box, an empty
`Blockers` section (or `None.`), and passing commands from `Verification`. Only then does it
write `state: done` and move the whole task directory (including sibling artifacts) into
`04-projects/personal/ocean/tasks/archive/Ocean/`. `--no-verify` is rejected. Read-only commands such as
`ocean tasks list` do not mutate files.

Tasks marked `done` by an external editor are checked for blockers, acceptance criteria, and
passing verification before they move. The dry run reports blocked tasks without changing them:

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
