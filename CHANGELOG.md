# Changelog

Every pull request adds a line under **Unreleased** (the `changelog` CI check fails
otherwise). Format: `- <type>(<scope>): <what changed and why it matters> (#<PR>)`.
Docs-only or CI-only PRs may add the `skip-changelog` label instead.

## Unreleased

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
