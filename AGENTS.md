# Working in Ocean

Local-first Node.js runtime for headless AI agents (Claude, Codex, Gemini, Hermes,
Antigravity). Public, provider-neutral engine; private data lives outside it.

## Commands

```bash
pnpm install          # deps
pnpm build            # tsc
pnpm test             # build + node --test tests/*.test.mjs
pnpm typecheck        # tsc --noEmit
pnpm check:style      # biome check .
```

## Hard rules

- No credentials, no personal data — anywhere in source, config, logs, tests, docs.
- Public code only under `packages/*/src/`. Provider execution only under
  `packages/harness/src/infrastructure/providers/`.
- Private personal/project data (`brain/`) lives as a sibling of this repo, outside it
  entirely. Machine-local state (`bridge/` — profiles, sessions, config, registry,
  integrations, archive) is physically nested inside this repo but git-ignored; never
  commit any of it.
- `sessions/sessions.sqlite` holds session metadata/events/links only — nothing else.
- Never add: `Adapters`, `Handoff`, `Mission`, `Coordinator`, the legacy Python/Bash
  runtime, hosted services, Postgres, Redis, dashboards.
- Never touch `.mcp.json`, `.cursor/`, `.gemini/`, `.claude/settings.json`, or any
  `pnpm-lock.yaml` entry without asking first.

## Cut tokens before reading code

1. `graft ask "<question>" --source` first, always — never grep or open files cold.
   Full tool set: `skills/core/graft/SKILL.md`.
2. `catch-up` skill before touching anything you didn't just finish.
3. `core-thinking` before executing; smallest valid solution, not the biggest.
4. `verification` after — a claim isn't done until it's independently checked.
5. `session-handoff` when done — compact packet, not a transcript.

Headless prompts carry references, not bodies: a skill index with SKILL.md paths, a compact
profile contract, a facts digest (<= 2 KB, with a pointer) and context references (paths + why),
assembled in `packages/harness/src/application/runs/prompt-assembly.ts` and
`packages/harness/src/application/context/context-references.ts`. `ocean context cost` reports each
client's always-on bytes (rules, memory index, skill frontmatter).

<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->
