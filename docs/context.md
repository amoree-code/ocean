# Context

A headless run (`ocean run`, the scheduler, the task loop, the gateway) sends the provider one
prompt assembled by `runAgent` (`src/application/runs/run-agent.ts`). Every supported provider
is an agentic CLI with file access, so the prompt carries **references, not bodies**: the
provider reads a file only when the request needs it. Formatting lives in
`src/application/runs/prompt-assembly.ts`; context references in
`packages/context/src/context/context-references.ts`.

## Prompt sections

Non-empty sections are joined with a blank line, in this order:

| Section | Content | Bound |
|---|---|---|
| `request` | the request text | — |
| `profile` | `## Effective Ocean profile` as compact `key: value` lines; empty and default fields are omitted, `writePolicy` is always shown | — |
| `instructions` | `profile.instructions` | — |
| `skills` | `## Ocean skills`: one line per profile skill, `- name: description (path to SKILL.md)`; bodies are not inlined. Owner-reviewed promoted skills matched by the request follow inline, since they have no SKILL.md | description 300 B; promoted skills 4 KB total, a truncated one ends with a marker naming its entry id, `ocean skill list` and the candidate store file (not granted: it also holds unreviewed candidates) |
| `facts` | `## Durable profile facts`: newest first, then a pointer to the full set (`ocean memory facts <profile>` and the store file) | 2 KB including the pointer |
| `handoff` | `## Ocean handoff` with the compact handoff context, verbatim | handoff budget |
| `context` | `## Context references`: `- path (recordType, bytes B): reason` per reference | 4 KB; overflow is listed in the manifest |

## How references are chosen

1. **`profile.contextSources`.** Each entry is resolved against the run's working directory with
   `realpath`, and kept only if its canonical path equals or lies under the canonical path of one
   of `profile.allowedPaths`. An entry that does not resolve, or that escapes through a symlink,
   is recorded in `omitted`. A kept entry is `stat`'d for its size and never opened.
2. **Context packet.** When `profile.memory.enabled`, the request is classified
   (`intent-router.ts`) and, only when it resolves to the exact-record rung of the T-198 ladder
   (`context-ladder.ts`: a task lookup naming one validated id), passed to the context packet
   (`context-packet.ts`), which selects that task's `task.md`. Memory, knowledge and decision
   lookups are not used headlessly: they are keyword-triggered ("memory", "recall", "lesson",
   "best practice"), so they would point ordinary engineering prompts at private records. A
   selected record must also lie inside `profile.allowedPaths` (the same realpath boundary,
   resolved against the run cwd); one that does not is recorded in `omitted`. Unknown or
   low-confidence intents select nothing, and any error (a malformed project-bindings file, for
   example) also fails closed to no references, so a run never fails on a file it would not
   have read.

Paths recorded in events are always relative: to the run cwd for `contextSources`, to the Ocean
root for packet records. Only the prompt, which is persisted as a hash, carries the absolute form.

## Context manifest (`src/domain/context/context.ts`)

```ts
{
  files: string[],                  // referenced contextSources entries
  bytes: number,                    // size of the context-references section
  maxBytes: number,                 // the section cap (4096)
  omitted: string[],                // disallowed, unresolvable or overflow references
  compactedSummary: string | null,  // null
  compression: object | null,       // null: nothing is inlined, so nothing is compressed
  lastContextCheckpoint: string,    // ISO timestamp of this build
  references: {                     // what the prompt points at (defaults to [])
    path: string, base: "cwd" | "ocean-root", recordType: string,
    reason: string, bytes: number | null,
  }[],
}
```

Validated by `validateContextManifest` (Zod). `runAgent` records it as a `context_manifest`
session event before the provider runs (see [sessions.md](sessions.md#events)).

`context_cost` records `bytes` (the whole prompt), `sources`, `handoffId`, `selectedSkills`
and `sections`: the byte size of each section above plus `separators` (2 bytes per join), which
sum exactly to `bytes`.

## Loading phases

Ocean does not scan all sessions, tasks, personal files, daily files, or transcripts at startup:

1. Bootstrap session metadata and the selected profile.
2. Load the requested task or compact handoff, when supplied.
3. Resolve skill paths, the profile facts digest, and context references; no skill or context
   body is read.
4. Read full artifacts only through an explicit CLI or MCP retrieval, or when the provider opens
   a referenced path itself.

`contextCompression` stays in the profile schema and in the profile identity hash, but it has no
effect on headless prompts now that no context body is inlined, and the profile contract does
not mention it. `packages/context/src/context/context-compression.ts` has no production caller; only its
unit tests exercise it.

Read access: the prompt points the provider at files it must be able to open. `runAgent` passes
these directories outside the run cwd as `readDirectories` on the provider request:

- each skill's folder;
- the profile facts store directory (`system/memory/profiles/`), only when the digest left facts
  out; the grant is the directory, so it also covers other profiles' fact files;
- the canonical parent directory of a context reference, only when that directory itself lies
  inside the profile's canonical `allowedPaths`. A single-file `allowedPaths` entry is referenced
  but never widens to its siblings, and a symlinked entry grants its real location, not the
  link's folder.

Claude receives one `--add-dir <dir>` and Gemini one `--include-directories <dir>` per directory,
so their workspace-confined file tools can read them. `--add-dir` applies to one invocation, so
`resumeAgent` rebuilds the same grant for a resumed Claude turn: the skill index again (the
profile identity is unchanged), the facts check against the current store, and the references
read back from the session's `context_manifest` event. A skill or facts lookup that fails at
resume time (a skill removed since the first turn, an unreadable facts file) drops that part of
the grant instead of failing the turn. Codex's read-only sandbox, Hermes and
Kilo read outside the cwd without a grant.
Antigravity (`--sandbox`) and Kimi have no such flag wired and may be unable to open a skill
outside the cwd; the index line still carries the skill's name and description.

## `ocean context cost`

A read-only report of what each interactive client loads on every request before the user types
anything:

```bash
ocean context cost [--json] [--budget <bytes>] [--project <dir>]
```

- Clients: claude, codex, gemini, hermes, cursor, antigravity (the skill roots `ocean skill sync`
  uses) plus a shared `~/.agents` row.
- Always-on bytes = global rules file(s) (Claude and Gemini `@path` imports resolved one level,
  ignoring code) + Claude's per-project `MEMORY.md` for `--project` (default: cwd; keyed by the enclosing git
  repository root, and a linked worktree by its main checkout, as Claude does) + the
  frontmatter of every installed skill. Skill body bytes are reported but not counted.
- Columns: `client | rules | memory | skills | skill-fm | skill-body | always-on | status`
  (`ok`, `OVER` when above `--budget`, default 12288, or `absent`).
- Per-client assumptions (rules file precedence, memory auto-loading, unknown rules locations)
  are printed as notes. Project-level rules files are not measured.
- Output holds only `~/...` display paths, byte counts and fixed notes, never file contents. The
  command exits 0 even when a client is over budget.
