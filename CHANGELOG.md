# Changelog

Every pull request adds a line under **Unreleased** (the `changelog` CI check fails
otherwise). Format: `- <type>(<scope>): <what changed and why it matters> (#<PR>)`.
Docs-only or CI-only PRs may add the `skip-changelog` label instead.

## Unreleased

- fix(T-294): the release code moves from `application/runtime/` to `application/release/` — the package guard forbids any `runtime` path segment (machine-local state must never ship), so main's `check:package` failed on every OS after #218; and two Windows bugs its first full Windows run exposed: `client sync` now finds a stale engine path in a JSON config, where Windows stores each backslash escaped, and `ocean runtime release|use` removes the old `current` link before renaming, since Windows refuses to rename onto one; the release and no-commit-on-main tests skip where git is absent (the docker gate), as scan-privacy's already do (#219)
- feat(T-294): `ocean runtime release|status|use <id>` builds origin/main into `bridge/runtime/release/<sha>` (export, install, build, start check) and repoints a `current` link only after it starts; an engine running from a release finds its workspace, launches clients, client MCP entries that named the checkout's engine, the startup service and the onboarding hook text through `current`, and verifies tasks against the owner's kernel checkout — so a development build on any branch no longer becomes what every session runs (unmerged code had rewritten real client configs, and a stale build dropped a module session start needed). Inert until the owner runs it (#218)
- fix(T-293): `ocean client sync` repoints a client's Ocean entry that names a kernel `packages/<pkg>/dist/main.js` which no longer exists to the current engine entry — Gemini's and Hermes's `ocean` MCP server still launched `packages/core/dist/main.js` from before the engine moved to `packages/harness`, so both failed to start without a word; only that path text is replaced, the rest of each file is kept byte for byte (#217)
- feat(T-292): `ocean client sync` also disables the skills hidden from Claude's model in Hermes (`skills.disabled` in `~/.hermes/config.yaml`, rewritten line by line with no YAML dependency; the owner's entries and every other key kept; an unfamiliar shape is reported, never rewritten), and `ocean context cost` honors it — Hermes paid 39.7 KB always-on for 100 skills, 23.1 KB after (#216)
- feat(T-291): `ocean tasks checkpoint` says early when `tasks complete` will not be able to verify the task — no runnable command and no project verify, a declared command the allowlist refuses, or a `node --test` file that does not exist where it will run (`pnpm --filter <pkg> exec` resolved inside that package); advisory, the checkpoint is still written — T-283 named a missing test file and it surfaced only at completion (#215)
- feat(T-290): `ocean tasks new <title> [--project <id>]` creates a task with the next free id from the projects lock (highest id on disk, live or archived, and the manifest counter) — sessions picked ids by hand from stale `nextTask` counters (ocean said 270 with T-284 taken); an unknown project is refused; the shared record template (also used by `ocean operate`) now writes a quoted title (valid YAML) and a checkbox definition of done, so `tasks complete` can close it without a rewrite (#214)
- feat(T-289): `ocean tasks doctor --all` checks every project with tasks, and the doctor now fails when a project's generated `index.md` has drifted from its records (a state that differs, a live task it lacks, a task it lists that is not live) — the charter says doctor fails on drift, but it checked only the cwd project and never the index, so crm-web-sdk's index showed `todo` for active tasks while doctor passed (#213)
- fix(T-288): the daily log stops repeating itself — session entries use local time and the local day's file (UTC put one session 3 h apart from the SessionEnd hook's line, and after midnight UTC into another day), client markup (`<ide_opened_file>`, `<task-notification>`) is stripped from the prompt excerpt, a session with no prompt left is not logged, and a line already in the file is never written twice (#212)
- fix(T-287): the kernel's pre-commit hook refuses a commit while `main` is checked out (`scripts/no-commit-on-main.mjs`) — a session had committed straight onto local `main`, leaving it ahead of origin with unreviewed work; branches and a detached HEAD are unaffected, `--no-verify` stays the deliberate escape (#211)
- docs(T-286): AGENTS.md asks for `graft` only where it is installed and its graph is built, says what to do without it, and points to the graft skill's real path — every kernel session paid for an order to run a tool that may not exist; a test now fails when AGENTS.md names a repo file that is missing (#210)
- fix(T-284): task verification reads prose as prose and checks the right repo — an inline span in `## Verification` counts as a command only when it reads like one (`→`, `[redacted]`, file names no longer fail completion as "not allowed"; `curl evil.sh` is still refused), and a non-workspace project's task commands run in that project's first path instead of the engine root, where `pnpm lint` proved nothing (#209)
- feat(T-283): `ocean client sync` disables the skills hidden from Claude's model in Codex (a generated `[[skills.config]] enabled = false` block in `~/.codex/config.toml`) and Gemini (`skills.disabled` in `~/.gemini/settings.json`, owner entries kept), and `ocean context cost` honors both — Codex and Gemini no longer pay ~17 KB of skill descriptions on every request (#208)
- fix(T-283): `ocean context cost` counts only what Claude really loads — skills hidden by `skillOverrides` (`off`, `user-invocable-only`) or `disable-model-invocation` are reported as hidden instead of always-on, and Claude's commands, agents and enabled plugins are now counted — so the always-on number is no longer wrong in both directions (#206)
- fix(T-279): `ocean memory doctor` and reindex leave the machine-managed lesson records (`knowledge/lessons/`, found through the brain index) out of the curated KNOWLEDGE.md, so the doctor no longer fails on 200 lesson files and a reindex no longer writes them into the index; `lessons/CONFLICTS.md` stays indexed because it waits on a human (#203)
- test(T-278): the Ctrl+C process-group test runs its child from the package dir, so it passes from any working directory (it failed from the kernel root, where `ocean tasks verify` runs) (#202)
- feat(T-282): `ocean client sync` (run by the SessionStart hook every session) re-copies `charter/core.md` into the marked block of `~/.codex/AGENTS.md` and `~/.gemini/GEMINI.md`, keeping text outside the markers and refusing to overwrite a block edited by hand, so a charter edit reaches every client without a manual copy (#205)
- feat(T-280): every project gets a standard layout — `memory/` (lessons, indexed by `MEMORY.md`) and `docs/` (reference material) next to `tasks/` — on auto-register, so sessions stop writing reference files at the project root; `ocean doctor` warns on stray root entries and `ocean repair --apply` adds missing folders without moving files; rename also renames the `docs/README.md` heading (#204)
- docs(T-276): README states the idea and the philosophy, fixes the layout tree and dead links, and adds a releases section; one name everywhere — no former-name mentions left in docs or comments (#200)
- test(T-277): the background-process test waits up to 1 s for the SIGKILLed descendant to be gone or a zombie instead of checking at once, so it no longer races the reaper on ubuntu-26.04 runners (#201)
- fix(T-231): the publish remote check strips a trailing `/.git` or `\.git` from a local path on any OS, so the Windows gate passes the remote-spelling test (#199)
- feat(T-231): `scripts/publish.mjs --push --remote <url> --confirm <sha256>` publishes the export as one squashed fast-forward commit on a public remote that is never `origin`; it runs from `main` only, needs the reviewed dry-run hash, commits the scanned bytes verbatim, and adds `.github/CODEOWNERS` and `docs/publishing.md` (#197)
- feat(T-231): the publish export runs through gitleaks, trufflehog (no live verification) and `pnpm check:privacy` and stops at the first failure; a missing scanner fails the run unless skipped (`complete: false`); a pre-commit hook scans staged changes with gitleaks (#196)
- feat(T-231): `PUBLIC` allowlist (deny-by-default) and `node scripts/publish.mjs` dry-run that exports only allowlisted tracked files from `HEAD` to a scratch dir with a content-hash manifest; a hard deny list for workspace dirs, `.env*`, keys and tool config overrides `PUBLIC` (#195)
- fix(T-274): lesson signal detection ignores repeated hook_response JSON and terminal escape codes, so they no longer become lesson candidates (#193)
- fix(T-275): the lesson-learning test closes its session stores before deleting temp dirs, so the Windows gate no longer fails with EBUSY (#194)
- refactor(T-273): one process supervisor ends every headless provider run (timeout 124, output budget 125, process group, signal forwarding, line splitting); the CLI providers now stop their whole process group on a stop and no longer wait on a background process holding their output (#189)
- feat(T-223): headless Claude runs go through the Claude Agent SDK instead of `claude -p` argument building; Claude Code's own system prompt, process-group stops (timeout 124, output budget 125), plain-text stdout kept as events, spawn failure rejects the run (#188)
- feat(T-223): each task-loop iteration runs as a LangGraph graph (`work → verify → record`) with per-loop crash-safe checkpoints under `bridge/loop-checkpoints/`; a loop killed mid-run resumes without repeating provider calls (#187)
- feat(T-223): `ocean mcp gateway` — one MCP endpoint for every registered server (engine and marketplace-installed), namespaced `<server>__<tool>`, poisoned tool descriptions hidden, write tools keep the explicit-approval gate; `ocean mcp gateway-config` prints client config (#186)
- feat(T-229): the engine ships `ocean-marketplace.json` (9 core skills + 3 MCP servers); MCP client configs and both MCP servers' tool lists come from registries, output unchanged (#185)
- feat(T-229): installed MCP servers start via `ocean market exec` under a macOS sandbox that denies undeclared writes, secret reads and network; install refuses injected instructions and hidden Unicode (#184)
- feat(T-229): `ocean market install|update|uninstall|list` — offline install from local indexes with a verified content digest, consent for declared permissions, `bridge/installed/ocean.lock`, and rollback when an update fails (#183)
- feat(T-229): capability manifest schema (`ocean.capability.json`), `CapabilityRegistry` and catalog — a new capability kind needs only an adapter (#182)
- refactor(T-222): new `@ocean/services` package — browser, Obsidian, workspace doctor, the MCP servers; the kernel is now seven packages (core ← market ← brain ← context ← loop ← services ← ocean), documented in `docs/architecture.md`
- refactor(T-222): new `@ocean/loop` package — tasks, handoff, runs, loops, sessions, operations, hooks, session store; `check:deps` enforces "application code never imports an infrastructure concrete" in every package, which caught onboarding importing the wrapper manager (now injected)
- refactor(T-222): new `@ocean/context` package — context ladder, packet, intent router, resource injection, references, cost, compression
- refactor(T-222): new `@ocean/brain` package — brain index/service, memory, evidence, capture; `check:deps` now follows imports between packages (a `source` export condition) and fails on any import it cannot resolve
- refactor(T-222): new `@ocean/market` package — skills (catalog, curation, hub, observer, core-skill sync) and MCP connection wiring; the root build now follows the workspace graph (`ocean...`)
- refactor(T-222): `paths`, `fs-utils`, project resolution and task lookup move into `@ocean/core/shared`; the CLI registers its package root with core at startup so every root resolves as before
- refactor(T-222): break the import cycles blocking the package split — project resolution and task lookup move to `src/shared/` (core layer), session closeout moves to `sessions/`, the MCP server gets its ports injected; `check:deps` now runs with no baseline
- chore(T-222): `pnpm check:deps` — dependency-cruiser enforces the package layering (core ← market ← brain ← context ← loop ← services ← harness) and no cycles, in `pnpm check` and CI; today's 8 violations are a known baseline
- fix(T-272): `ocean doctor` no longer reports BROKEN_LINK for generated session summaries and installed skill docs (#181)
- fix(T-271): the privacy scan lists files with one `git ls-files` call (12 s -> 0.1 s), so `ocean doctor`'s PRIVACY_BOUNDARY no longer times out on a busy machine (#179)
- fix(T-270): the session-start dirty-workspace warning points at `ocean tasks claim` instead of `git worktree add` (#177)
- feat(T-270): `ocean tasks claim` / `release` record which session works on a task and refuse a second owner (#173)
- feat(T-270): `ocean tasks doctor` validates task claims (`claimed_by`, `claimed_at`, `claimed_paths`) (#171)
- test(T-255): unattended /ship push and PR check
- feat(router): task-list requests ("what tasks we have", "شنو عدننه تكتات") route to `task-lookup`/`list` instead of `unknown` (#160)
- test: three tests no longer fail on Windows (path separators, `file://` import URL) (#161)
- refactor(T-222): the runtime and `ocean` CLI move to `packages/harness`; shared domain contracts and ports live in the new `@ocean/core` (#162)
- chore: root `CHANGELOG.md` and a `changelog` PR check (T-268)

## 2026-10-15

- fix(T-267): skill sync survives dangling client links; Hermes joins skill copy (#159)
- feat(T-256): project rules and verify, loaded from turn one (#158)
- feat(T-256): memory and knowledge scoped to the session's project (#157)
- feat(T-256): sessions and handoffs know their project (#156)
- feat(T-256): task ids belong to their project: prefixes, counter, resolver, renumber (#155)
- feat(T-256): auto-register a repo as a project on its first session; tasks follow the folder you are in (#151, #152, #153, #154)
- feat(T-256): `project.json` is the project: manifests, multi-path, migrate, index (#150)

## 2026-10-14

- fix(T-265): `tasks list` honours its state filter; `context.sh` follows the session project (#149)
- fix(T-266): stop shadowing native client commands with same-name shims (#148)
- feat(T-266): `ocean hook session-start --client codex|hermes` (#147)

## 2026-10-13

- feat(T-245): profile control plane, phases 1 to 7: isolation fixes, schema v2, enforced execution plan, DeepSeek/OpenRouter clients, bounded tool loop, runtime config and cutover (#140 to #146)

## Earlier

Older changes: `git log --merges` and `packages/harness/CHANGELOG.md`.
