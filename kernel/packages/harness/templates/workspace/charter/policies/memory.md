# Policy — memory

Load when recording or retrieving a durable fact about the owner.

**Memory answers: what is true about the owner and their world.** Lifespan: years.
`~/ocean/02-personal/<section>/`.

**The test when it is ambiguous:** would this still be true if they never wrote another line
of code? Yes → memory. No → knowledge (`knowledge.md`).

## One home

Ocean is the only memory home (`05-knowledge/decisions/ocean-is-the-only-memory-home.md`).
A client's own store (Claude Code, Codex, Gemini, Hermes, Antigravity, claude.ai) is a cache:
promote a durable fact found there into Ocean; on conflict Ocean wins.

## Sections

`identity/` · `education/` · `career/` · `projects/` · `goals/` · `travel/` ·
`preferences/` · `interests/`

**One canonical home per fact.** A fact touching two sections lives in the one matching its
meaning; the other links to it. Example: a course funded by a grant lives in `education/`,
the move it requires in `travel/`, and neither repeats the other. No place or topic gets its
own section just because it recurs.

Project *implementation* detail stays in the repo at `.claude/memory/`, not here. Project
memory lives in `04-projects/<project>/memory/` (indexed by its `MEMORY.md`); reference
material lives in `04-projects/<project>/docs/` — never at the project root.

## Retrieval — never load everything

```
task → identify the domain → read the index → open only what it names
```

`memory/MEMORY.md` is the index and the only file read by default. A React question needs
`preferences/`. A question about that course needs `education/` and `travel/`. Neither
needs the other. Reading the whole store is a mistake, not thoroughness.

## Promotion

```
observation → candidate → classify → promote? → memory | knowledge | discard
```

Promote only what will still be true and useful in a month, is not already recorded, and is
not derivable from the repo or git history. **Most observations promote to nothing** — that
is correct, not a failure. Search before writing; update an existing entry rather than
adding a near-duplicate. Never store secrets or temporary debugging state.

If a fact fits no existing section, say so and propose one rather than scattering it into
the nearest file.

## Conflicts

New information contradicting a record is never silently kept alongside it and never
resolved by invention. Record both versions in `memory/CONFLICTS.md`, ask which is current,
then update the owning file and remove the entry. Supersession by time — a job change, a
finished certificate — is not a conflict: update it, and mark the old value `historical` if
it still explains something.

## Writing

Delegate to `memory-curator`. It owns the section routing, the frontmatter schema and the
conflict procedure. `ai-memory doctor` checks structure, duplicates, broken links and
orphans.
