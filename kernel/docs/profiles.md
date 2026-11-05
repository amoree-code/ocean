# Profiles

A profile is one JSON file describing one agent configuration. `profile.json` is the machine-enforced
contract, including concise instructions and verification commands.

## Storage and loading

Profiles live at `<workspace>/bridge/profiles/<name>.json` (see [workspace.md](workspace.md)).
`loadProfile(name)` (`src/infrastructure/filesystem/profile-loader.ts`) reads and validates the single
canonical JSON file; legacy profile directories are read only for compatibility during migration.

## Schema (`src/domain/profiles/profile.ts`)

```ts
{
  name: string,                                        // non-empty
  description: string,                                  // default ""
  version: string,                                      // non-empty, default "1.0.0"
  provider: "claude" | "codex" | "gemini" | "antigravity" | "hermes" | "kilo" | "kimi",
  model: string,                                        // non-empty
  role: string,                                         // non-empty
  skills: string[],                                      // default core-thinking + verification
  allowedPaths: string[],                                // default []
  allowedCommands: string[],                             // default []
  writePolicy: "none" | "workspace" | "allowed-paths",  // default "none"
  contextSources: string[],                              // default []
  contextCompression: "none" | "ocean-bounded",        // default "none"
  clients: { [client: string]: { enabled: boolean, model?: string, profile?: string,
    home?: string, mode?: string, capabilities: string[], limitations: string[] } },
}
```

Validation is via Zod (`profileSchema` in `profile.ts`, applied by
`validateProfile` in `profile-validator.ts`); an invalid profile throws before an agent run
starts. `description` and `version` are both optional on disk (they default to `""` and
`"1.0.0"`), so profiles written before these fields existed keep loading unchanged.

## Fields in use today

- `provider` and `model` select which provider CLI runs and are passed through to it
  (see [providers.md](providers.md)).
- `contextSources` and `allowedPaths` bound what a headless prompt references — a source path,
  or a task record selected by the context packet, is only referenced (path and size, never its
  body) if it resolves inside one of `allowedPaths` (see [context.md](context.md)).
- `allowedCommands` is checked before a run starts: when non-empty, the selected provider
  command must appear in the list. `writePolicy` is validated at the same boundary;
  `allowed-paths` requires at least one allowed path. Provider processes still need a
  sandbox or client-native write boundary to enforce individual file writes.
- `description` is a free-text summary of what the profile is for; it has no runtime effect.
- `clients` is the provider capability overlay. It does not duplicate role policy: the same role,
  paths, commands, approval, verification, and skills apply to every enabled client. Only the
  selected client's model/home/mode/capabilities/limitations are added to effective context.
- `version` is a human-assigned label for a profile's configuration (bump it when you
  change a profile's fields); it participates in the identity described below.

When `skills` is empty, Ocean selects only `core-thinking` and `verification`. This is the
small default set; expensive or promoted skills remain prompt-matched and owner-reviewed.
`contextCompression` is kept in the schema and the profile identity, but has no effect on
headless prompts (and is not written into the profile contract): context sources are
referenced, not inlined, so there is nothing to compress.

Writable profiles fail closed because direct provider execution cannot enforce file writes.
`writePolicy` is therefore not treated as advisory; an enforcing sandbox must be added before
profiles with write access can run.

## Session reproducibility (`profileIdentity`)

A profile file can be edited after a session has already been created from it, so a
session records more than the profile's name: `profileIdentity(profile)`
(`src/domain/profiles/profile.ts`) hashes every field of a `Profile` (sha256 of a fixed-key
JSON encoding, including `version`) into one deterministic string. `runAgent`
(`packages/loop/src/runs/run-agent.ts`) computes this hash when it creates a session and
stores it as `Session.profileIdentity` (persisted as the `profile_identity` column in
`sessions.sqlite`, see [sessions.md](sessions.md)).

Two profiles with identical fields — including `version` — always produce the same
identity; changing any field, including bumping `version` alone, changes it. This lets a
session be traced back to the exact profile configuration that produced it, independent of
how the profile file on disk has changed since. Sessions created before this field existed
read back with `profileIdentity: ""`.

## Profile vs. project vs. session

These three are easy to conflate because all three can be named on the command line, but
they answer different questions:

- **Profile** (`bridge/profiles/<name>.json`) — *how* an agent runs: provider, model, role,
  skills, and read/write policy. It is configuration, reused across many runs, and owns no
  data of its own.
- **Project** (`04-projects/<name>/`) — *what* the work is about: the tasks, plans, and
  private notes for one piece of work (see the workspace-root layout in
  [workspace.md](workspace.md)). A project has no execution configuration; a profile
  points at paths, it does not define what lives there.
- **Session** (one row in `bridge/sessions/sessions.sqlite`) — *one run*: the record of a single
  agent invocation, which profile (and, via `profileIdentity`, which exact profile
  configuration) produced it, its status, and its transcript of events (see
  [sessions.md](sessions.md)). A session is created fresh every time `ocean run` starts,
  and can be resumed, but it never becomes a profile or a project.

A profile is loaded by name for a run; the run happens against a project's files (via
`cwd`/`allowedPaths`); the result of that run is one session.

## Default profile

`ocean setup` writes `bridge/profiles/default.json` from
`templates/profiles/default.json` if it does not already exist:

```json
{
  "name": "default",
  "description": "General-purpose assistant profile for ad-hoc work across the active workspace.",
  "version": "1.0.0",
  "provider": "claude",
  "model": "sonnet",
  "role": "general assistant",
  "skills": [],
  "allowedPaths": ["."],
  "allowedCommands": [],
  "writePolicy": "workspace",
  "contextSources": []
}
```

## Role profiles

`templates/profiles/` also ships public starter templates for three other roles; unlike
`default`, `ocean setup` does not install these automatically — copy the one you need into
`bridge/profiles/<name>.json` under the workspace root:

- **`strategist.json`** — plans and reasons about approach; `writePolicy: "none"`.
- **`developer.json`** — implements and fixes code; `writePolicy: "workspace"`.
- **`reviewer.json`** — reviews changes and reports findings; `writePolicy: "none"`.

The active instances a workspace actually runs with live only at `<workspace
root>/bridge/profiles/<name>.json` — never inside `kernel/`.

The root-level JSON form is canonical. The older directory form with `profile.json` and
`instructions.md` remains read-compatible during migration; it is not a second authority.

## Skill roots

Profile skill names resolve progressively in this order: public `engine/skills/`, private
`bridge/integrations/claude-code/skills/`, then the active project's `skills/` directory under
`04-projects/<project>/skills/`. Each private or project root uses the same `index.json` and
`<category>/<name>/SKILL.md` contract as the public catalog. The first matching name wins and
duplicate profile names are listed once. The prompt carries a skill index (name, description,
SKILL.md path); the provider reads a skill's body on demand. Owner-reviewed promoted skills,
which have no SKILL.md, stay inline up to 4 KB in total. Private and project skill content never belongs in
the public engine repository.

The local Agent Skills validator runs with `pnpm check:skills`. CI runs the same pinned
Node.js script (`scripts/validate-skills.mjs`) and checks every public `SKILL.md` against its
frontmatter, directory name, and `skills/index.json` entry. It is a development check only;
runtime skill loading does not invoke CI tooling.

Completed sessions can produce a bounded, redacted skill candidate with
`ocean skill learn <session-id>`. The candidate is stored privately with its source session
and remains inactive until an owner explicitly runs `ocean skill review <id> promoted`.

## Suggesting a profile for a task (T-296)

`ocean profiles suggest --task <id> [--profile <name>]` reads the task record and applies a fixed
rule table (`packages/core/src/domain/profiles/profile-selection.ts`): the declared `kind` first,
then the title and objective — security → `security-auditor`, review → `reviewer`, tests →
`tester`, delivery → `devops`, research → `researcher`, planning → `strategist`, implementation
→ `developer`. The first matching rule wins; no match, or a profile that is not installed, gives
`default`. `class: high` or `risk: high` adds "verify before completing" to the reason. An
explicit `--profile` always wins. Every selection, suggested or overridden, is appended to
`bridge/state/profiles/selections.jsonl`.

`ocean run --task <id>` without `--profile` uses the suggestion only when
`bridge/config/runtime.json` sets `"autoProfile": true`; otherwise `defaultProfile` applies as
before. The suggestion never widens a run on its own: it names an installed profile, whose own
`writePolicy` and allowed paths still bound what the run may do.
