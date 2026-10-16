# Changelog

Every pull request adds a line under **Unreleased** (the `changelog` CI check fails
otherwise). Format: `- <type>(<scope>): <what changed and why it matters> (#<PR>)`.
Docs-only or CI-only PRs may add the `skip-changelog` label instead.

## Unreleased

- refactor(T-222): new `@ocean/context` package — context ladder, packet, intent router, resource injection, references, cost, compression
- refactor(T-222): new `@ocean/brain` package — brain index/service, memory, evidence, capture; `check:deps` now follows imports between packages (a `source` export condition) and fails on any import it cannot resolve
- refactor(T-222): new `@ocean/market` package — skills (catalog, curation, hub, observer, core-skill sync) and MCP connection wiring; the root build now follows the workspace graph (`ocean...`)
- refactor(T-222): `paths`, `fs-utils`, project resolution and task lookup move into `@ocean/core/shared`; the CLI registers its package root with core at startup so every root resolves as before
- refactor(T-222): break the import cycles blocking the package split — project resolution and task lookup move to `src/shared/` (core layer), session closeout moves to `sessions/`, the MCP server gets its ports injected; `check:deps` now runs with no baseline
- chore(T-222): `pnpm check:deps` — dependency-cruiser enforces the package layering (core ← market ← brain ← context ← loop ← services ← harness) and no cycles, in `pnpm check` and CI; today's 8 violations are a known baseline
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
