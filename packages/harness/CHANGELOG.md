# Changelog

## Unreleased

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
