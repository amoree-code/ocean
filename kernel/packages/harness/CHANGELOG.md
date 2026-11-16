# Changelog

## 1.7.0

- fix(T-313): `ocean memory session-facts on|off` now sets the answer; it read the word after it instead, so it only ever showed the setting
- feat(T-314): follow-ups. `07-notes/` ships in the public repo as an empty folder; a session with no title gets its closeout handoff again (zod `too_small` on `title`, found by `ocean telemetry` in 113 sessions); `memory_propose` takes `contradicts: 07-notes/<note>.md`, and the disagreement waits in `02-personal/CONFLICTS.md`, the note untouched; `ocean distill --month` reviews last month against `goals.md`; `ocean onboard` asks stack, goals and topics, and `ocean interests signals` proposes topics recurring in sessions, all as candidates (#294)
- feat(T-314): `ocean express cv|linkedin|scholarship [--dry-run]` drafts a CV section, a LinkedIn post or a scholarship paragraph from the done milestones in `02-personal/milestones/` into `00-inbox/drafts/` for review — from the records only, no model, nothing sent (#293)
- feat(T-314): the journey: milestone and study Bases in the workspace template; each daily brief resurfaces one decision due for re-evaluation (last verified over 90 days ago) or one quiet note from `07-notes`; `ocean telemetry [--days N] [--yes]` turns errors recurring across sessions and providers that keep failing into proposed backlog lines (#292)
- feat(T-314): distill and review: `ocean distill --week [--yes]` writes `01-daily/weekly/<YYYY-Www>.md` from the week's session records and briefs, proposes their decisions and lessons as candidates, marks records `distilled: true` and archives processed captures; a `/weekly-review` skill walks to inbox zero; search now covers session records and briefs and skips `status: retired` records; `ocean memory archive-retired [--yes]` moves retired lessons to `lessons/archive/` (#291)
- feat(T-314): session records replace the brain-dump: each finished session writes `01-daily/sessions/YYYY-MM/<date>-<time>-<slug>.md` with flat frontmatter (`type: session`, project, provider, status, session_id, date, `distilled: false`) and fixed sections (Goal, Outcome, Decisions, Problems → fixes, Learned, Verification, Files / commits, Next); `ocean memory migrate-sessions [--yes]` moves older `00-inbox/brain-dump/` files there, never deleting one (#290)
- feat(T-314): interest discovery for any user: `ocean interests discover [--yes]` maps the dependencies of every registered project through a kernel source registry to release feeds and proposes each new topic as a review candidate; `ocean interests keep|skip <name>` adjusts weight; `ocean interests decay [--weeks N] [--yes]` lowers discovered interests with no signal, never ones the owner wrote (#289)
- feat(T-314): `ocean brief [--weekly] [--dry-run]` writes `01-daily/briefs/<date>.md` from the feeds of the interests in `02-personal/interests/` (`https://` RSS/Atom, or `github:<owner>/<repo>` releases): high priority and at most 5 items daily, every interest and at most 15 weekly, keywords narrow general feeds, a seen-ledger prevents repeats, and a failing source is listed rather than fatal (#288)
- feat(T-314): people, one file each in `02-personal/people/` (`type: person`, aliases in English and Arabic): the read-only `people_lookup` MCP tool matches a name exactly (file name, title or alias; case, spacing and Unicode form ignored; never part of a name), and the workspace template ships `people.base` (#287)
- feat(T-314): capture from anywhere: `ocean note "<text>"` writes a capture with frontmatter into `00-inbox/captures/` (secrets redacted), and `ocean obsidian templates [--yes]` generates Templater folder templates from `routing.json` (the owner's entries for other folders are kept); `docs/workspace.md` documents the Obsidian URI for Shortcuts, Raycast and QuickAdd (#286)
- feat(T-314): one routing table for records too: `routing.json` names the folder of every type with one home (capture, daily, session, brief, weekly, note, decision, lesson, solution, failure, discovery, architecture, research, result, person, interest, milestone, study; `experiential`, `technical-solution`, `task-result` as aliases). `ocean doctor` reports `TYPE_LOCATION` for a record outside its type's folder (a project's own memory/docs may hold any type) and `FRONTMATTER_MISSING` for a record without frontmatter; the workspace template ships a frontmatter template per type (#285)
- feat(T-314): flat frontmatter, so Obsidian Properties and Bases can read a record: `ocean memory flatten [--yes]` moves a nested `metadata:` block to top level (a key already top-level keeps its value; originals are copied to `bridge/archive/` first; `07-notes` is never touched), and session promotion and capture now write flat frontmatter (#284)
- feat(T-314): `ocean doctor` warns `INBOX_STALE` when inbox items sat more than 7 days, counted by folder (the inbox index and the clients' native memory staging are not items) (#284)
- feat(T-314): `07-notes/` is the owner's own notes root: `ocean setup` creates it, a memory write under it is refused as `PROTECTED`, and the brain index reads it as a `notes` store whose hits carry `origin: "human"` and rank above agent-written records on the same question (others carry `origin: "agent"`). A workspace made before it gets a `ROOT_MISSING` warning, not a failure (#284)
- feat(T-314): a session fact arrives with the place it belongs: the extraction asks the model for a fact type, and one routing table (`brain/src/memory/routing.json`: identity, preference, person, interest, goal, education, career, schedule, project) turns it into the candidate's `target`, one file per fact named after its title; a project fact goes to that project's `memory/` only when the project is registered. `ocean memory review approve <id>` needs no `--to` for such a candidate, and `--type <type>` routes one that has no target through the same table (#284)
- feat(T-315): `ocean desktop capture --export <folder>` reads the official claude.ai data export's `conversations.json`, so a conversation from the web or the phone reaches the same capture, with the same cursor (message times): a conversation already read from the app is not read again. `docs/mcp.md` gets a Watcher tier for Claude Desktop chat and explains the local store, its limits and `DESKTOP_CHAT_UNREADABLE` (#283)
- feat(T-315): Claude Desktop chat is captured with no command run: `ocean clients apply` adds a per-user LaunchAgent (macOS, Claude Desktop installed, session facts on) that runs `ocean desktop capture` when the app writes its chat store (at most every 5 minutes) and every 15 minutes. It is journaled and loaded with `launchctl`; `ocean clients restore` unloads and removes it, and a plist Ocean did not write is never touched. `ocean doctor` reports `DESKTOP_WATCHER_MISSING`, the last run, and `DESKTOP_CHAT_UNREADABLE` when an app update changed the store's format (#282)
- feat(T-315): Claude Desktop chat gets the same fact capture as Claude Code: `ocean desktop capture` sends the new turns of each conversation quiet for 10 minutes (`--quiet`) to the T-313 extraction, with a per-conversation cursor so each turn is read once and a failed model call hands its turns back. Candidates carry `source: session:desktop:<uuid>` and stay review-only. The cursor and the last run's outcome (for `ocean doctor`) hold ids and counts, never text (#281)
- feat(T-315): Ocean can read Claude Desktop's plain chat from the app's own local IndexedDB, with no dependency: a LevelDB reader (MANIFEST, logs, Snappy tables), Chromium IndexedDB keys, value wrappers and blob files, and Blink/V8 values. The folder is copied aside and read, never opened in place. `ocean desktop capture --dry-run` lists the conversations the app holds, with message counts and never text; an unreadable store is reported as `DESKTOP_CHAT_UNREADABLE` (#280)

## 1.6.2

- fix(T-313): session fact capture with Claude no longer loads Claude Code's own context: the call runs isolated (its own short system prompt, no settings or CLAUDE.md, no tools, no MCP servers, no saved session), which takes its fixed cost from about 30,700 tokens to about 1,000 per call

## 1.6.1

- docs(T-313): `docs/mcp.md` explains how the memory loop runs in code (read at session start, facts captured at session end and before a compaction) and what each client gets, from full integration to MCP-only best effort; the privacy scan now also runs before every push, not only before a commit and in CI (#277)

## 1.6.0

- feat(T-313): `ocean doctor` reports `RUNNING_STALE` when a client still runs an Ocean server older than the installed release (restart that client), from the release each call-ledger row now records; `ocean_status` adds `installed` and `restartNeeded`. The link check skips soft-deleted memory and candidates, which quote other tools' text (#276)

## 1.5.1

- fix(T-313): `ocean mcp gateway` now carries Ocean's memory contract (`instructions` in `initialize`, sent only to a client allowed to see Ocean's own server) and forwards resources and prompts as well as tools, so a client wired through the gateway (the default since 1.5.0) gets the same Ocean as a direct connection (#274)

## 1.5.0

- feat(T-309): `ocean mcp gateway` now routes remote MCP servers installed from the marketplace (streamable HTTP and SSE, through the official SDK client) alongside the stdio ones, instead of skipping them. A remote must be `https`, or `http` on loopback, with its host declared as a `network` permission; redirects stay on the same origin, and a remote that requires a header is refused rather than sent a credential. The marketplace now also accepts loopback `http` remotes at install (#267)
- feat(T-309): `ocean market add <server.json> [--yes]` installs your own MCP server (official registry format) through the same install path as any other: Ocean writes it into the owner's index with only the permissions its launch needs (runner and declared variables, or the remote's host), then the description scan, consent and the lock decide. A refused server is taken out of the index again, so it never installs or starts; `dev.ocean` names are reserved for the engine (#268)
- feat(T-309): `ocean mcp gateway` shows each client only the servers it may see, by the name the client gives in `initialize`; a server that declares file writes or drives a browser is hidden unless `bridge/market/gateway-access.json` allows it for that client, and `deny` hides any server. A hidden server is never started, so its tools cost that client no context (#269)
- feat(T-309): `ocean clients gateway <id> on|off` wires a client to one `ocean-gateway` entry (`ocean mcp gateway --installed-only`) in place of one entry per installed server; `ocean clients apply` swaps the entries both ways, Ocean's own `ocean` and `ocean-obsidian` entries stay direct so their tool names do not change, and a gateway entry the owner added by hand is never removed. `ocean doctor` reports the wired clients and fails an access file the gateway cannot read (`GATEWAY`) (#270)
- feat(T-309): `ocean market search <term>` lists servers from the official MCP registry, and `ocean market add <registry name>` installs one by name through the same scan, consent and lock as a `server.json`. A server's keys and tokens (declared variables, `{placeholders}` in arguments and headers, secret headers) come from the environment, then the macOS keychain, managed with `ocean market secret list|set|remove` (the value is read from stdin and never written or logged); remote servers that need a header are now routed. An optional value that is missing drops its argument instead of passing a literal `{token}` (#271)
- feat(T-309): the gateway is the default on a freshly onboarded machine (a machine wired before keeps per-server entries until `ocean clients gateway --default gateway`), with per-client exceptions (`ocean clients gateway <id> off`) kept across default changes. Each client's `ocean-gateway` entry carries `--client <id>`, so access rules use Ocean's client ids; `ocean clients allow|deny|unset <id> <server>` edits them, and installing a sensitive server prints the `allow` command for it (#272)
- feat(T-309): `ocean mcp status [--check] [--json]` shows every installed MCP server in one view: how it runs, whether it can start and why not, each value it takes and where it comes from (with the command that sets a missing one; never the value), and which clients see it through the gateway or their own entry; `--check` starts each ready server and counts its tools (#273)

## 1.4.0

- feat(T-298): the marketplace browser capability `dev.ocean/chrome-devtools` now runs the published npm package `ocean-browser-mcp@0.1.0` (source amoree-code/Ocean-BROWSER-MCP), which pins Chrome DevTools MCP 1.12.0 exactly and carries the attach and privacy flags itself; the name and the `chrome-devtools` client key are unchanged, so `ocean market update dev.ocean/chrome-devtools --yes` is the whole migration (#266)

## 1.3.0

- feat(T-298): `ocean clients apply` wires every MCP server installed from the marketplace into every supported client, as an `ocean market exec <name>` entry under its `clientKey`; it keeps them current, removes them once uninstalled, and never rewrites the owner's own server under the same key. New clients: VS Code (`servers` in its user `mcp.json`) and the Antigravity CLI (`~/.gemini/config/mcp_config.json`, which `agy` reads instead of the app's file). A marketplace server now finds `npx`/`uvx` next to the node running Ocean, so GUI clients that start it with the login PATH (Claude Desktop, VS Code) no longer fail with `spawn npx ENOENT`. The loopback browser bridge is retired (`ocean mcp browser-config`, `browser-bridge`, `browser-service install` removed; `browser-service uninstall` stays to clean up), and `ocean doctor` reports `BROWSER` for an installed browser capability instead of `BROWSER_BRIDGE` (#265)

## 1.2.0

- feat: the package is `@amoree-code/ocean` on npm too, the same name as on GitHub Packages and the repository; `@ameer.abdulkareem/ocean` stops at 1.1.0 and is deprecated in favour of it. Install with `npm install --global @amoree-code/ocean` (#264)

## 1.1.0

- fix(T-312): the release commit is made with git hooks off (`LEFTHOOK=0`): CI's `pnpm install` installs the repo's hooks, and the no-commit-on-main guard refused the release commit, so the first automatic release stopped before tagging (#263)
- feat(T-311): `ocean project move <id> <category> [--write]` files a project under its category folder and rewrites the workspace paths (records, projects, charter) that named its old folder, as whole paths only; without `--write` it reports what would change. `ocean doctor` warns on a project left flat (`PROJECT_FLAT`) or in `uncategorized/` (`PROJECT_UNCATEGORIZED`) and fails on one id with project.json in two category folders (`PROJECT_DUPLICATE_ID`); a folder holding project.json wins over a bare one of the same name (#263)
- feat(T-311): projects can live in category folders, `04-projects/<category>/<id>/` (`company`, `personal`, `freelance`, `former-company`, `vendor`); the generated project index groups them under one heading per category and `ocean project list --category <name>` lists one; every path to a project goes through one resolver (`projectDir`, `listProjectDirs`), which reads both that and the flat layout. A new project lands in `uncategorized/` (the workspace's own project in `personal/`), a category folder name is never a project id, and a record path or memory history written in either layout reaches the same record. `storeRelativeToRoot` now takes the root, so a search against another root cites its files (#263)
- feat(T-312): releases are automatic. Every push to `main` with something pending bumps the version (major on a `type!:` line, minor on `feat`, else patch), moves the Unreleased lines under the version in both changelogs, consumes the changesets, tags `v<version>`, writes the GitHub release, and publishes to npm through trusted publishing (no stored token) and to GitHub Packages. The 45 changesets that shipped in 1.0.0 are removed (#262)
- ci: each published release also goes to GitHub Packages as `@amoree-code/ocean` (the npm tarball, renamed to the scope GitHub Packages requires), from a `production` environment; `workflow_dispatch` with a tag publishes an existing release (#261)
- feat(T-310): one repository rooted at `~/ocean`: the engine moves to `kernel/` (history kept), every workspace folder ships as an empty `.gitkeep`, and the root `.gitignore` is a whitelist so no private file can be committed; `lefthook.yml` moves to the git root and CI runs inside `kernel/` (#260)

## 1.0.0

First public npm release, as `@ameer.abdulkareem/ocean` (`npm install --global @ameer.abdulkareem/ocean`, then `ocean setup`). Requires Node.js 22.16 or newer. The tarball carries the engine and an empty workspace template only; `ocean setup` creates the private workspace outside the package. Changes since 0.3.7:

- Make `package.json` the single version authority and remove the duplicate `VERSION` file.
- Replace the stale partial CLI help text with a grouped catalog of every top-level command.
- Ignore generated Graphify analysis output and document the current CLI module boundary.
- Upgrade to pnpm 12, TypeScript 7, and Zod 4.
- Add Biome and Knip quality gates plus a unified `pnpm check` command.
- Align task creation and validation with the current task contract while retaining legacy-task compatibility.
- Exclude Git-ignored, machine-generated files from the public privacy scan.
- Add an interactive approval gate for pending observations (capped to the 5 most recent);
  approving one now creates a skill candidate, with signal quality scoped to user input.
- Surface task observations in the daily narrative, and generate a human-readable session
  closeout and daily narrative with an opt-in model call.
- Wire in `graft` for local code-graph context during development.
- Harden Ocean runtime contracts and recovery, and fix newline-delimited JSON-RPC framing
  for the MCP stdio transport.
- Add reviewed skill learning from completed sessions, with auto-activation of reviewed skills.
- Add Kilo and Kimi as supported headless providers.
- Add provider-neutral MCP setup and complete Ocean client integration.
- Add governed Obsidian vault integration: read-only discovery, automatic hash sync, guarded
  writes, inbox promotion, and exposure through the provider-neutral MCP server.
- Make Ocean client-neutral with bounded context and cross-client sync (T-198); remediate
  security-audit findings.
- Add workspace context and safe maintenance commands (`ocean doctor`, `ocean repair`),
  `.nvmrc`/lefthook for local dev tooling, and a cross-platform Docker release gate.
- Fix a test that depended on the ambient `OCEAN_ROOT` instead of an isolated workspace,
  causing a false failure whenever a real Obsidian vault is connected on the host.
- Generate `skills/index.json` from each `SKILL.md`'s frontmatter instead of hand-maintaining
  it; `pnpm check:skills` now fails if the catalog drifts from the skill files.
- Add layer-scoped `AGENTS.md` files under `src/domain`, `src/application`,
  `src/infrastructure`, and `src/interfaces`.
- Add a PR template with a changelog checklist.
- Add an Obsidian sync flow diagram to `docs/mcp.md`.

## 0.3.7

### Patch Changes

- [#92](https://github.com/amoree-code/ocean/pull/92) [`6e7274c`](https://github.com/amoree-code/ocean/commit/6e7274ccb96e945b94d00afdd587a8dd4285e8d8) Thanks [@amoree-code](https://github.com/amoree-code)! - Adopt changesets for versioning: add `.changeset/` config (GitHub-flavored changelog,
  restricted access, patch bump for internal dependencies) and a `pnpm changeset` script.

## 0.3.6

- Add Hermes as a supported headless provider.
- Generate Hermes wrappers and invoke its native one-shot mode.

## 0.3.5

- Run headless providers through their original executable when Ocean shims are on `PATH`.
- Add coverage proving headless execution bypasses the managed shims.

## 0.3.4

- Make the `ocean` CLI available through the managed shell shim after setup.
- Verify the generated Ocean CLI wrapper forwards commands to the engine.

## 0.3.3

- Fix shell detection for Ocean CLI shim setup.
- Keep the public release gate green on the current mainline.

## 0.3.2

Release candidate for the Ocean v2 public engine foundation.

- Provider-neutral headless CLI execution for Claude, Codex, Gemini, and Antigravity.
- Validated profiles, bounded context, SQLite sessions, evidence, capabilities, MCP approval,
  run contracts, structured logs, Agent Skills, and release/privacy gates.
- Private workspace data remains outside the public engine package.

Publication remains subject to the release gate and owner approval.
