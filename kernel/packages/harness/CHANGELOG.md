# Changelog

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
