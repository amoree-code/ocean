# Claude Code — extended context

Claude-Code-specific detail beyond `governance/rules/core.md`. Loaded on demand via
`ocean policy claude-code-context`, not injected on every request.

## Technical defaults

Record the owner's stack here once it is known (package manager, runtime, framework per kind of
project, styling, data layer, validation), so every session starts from the same defaults instead
of re-deciding them. Until then: follow each repository's own conventions, use one formatter,
validate environment variables at startup, and do not migrate a legacy repository unasked.

## Task loop

The default shape of any non-trivial task:

```
UNDERSTAND → PLAN → EXECUTE → OBSERVE → TEST → VERIFY
   → error? → DIAGNOSE → FIX → RETEST (loop)
   → FINAL VERIFICATION → COMPLETE
```

Continue until the authorized task is actually complete. **Changing the code is not
completion** — completion is the verification passing. Do not hand work back mid-task, and
do not keep asking whether to continue normal work; if part of the scope is genuinely
blocked, finish everything else and say plainly what was left and why.

### Checkpoints
For any task longer than a few steps, checkpoint into the task record itself:

```bash
ocean tasks checkpoint <ID> --note "what landed, evidence, verification state" \
                            --next "the one next action"
```

The record at `04-projects/<project>/tasks/<ID>/task.md` carries objective,
definition of done, verification state, blockers and next action. Update it as steps land —
it is what makes recovery possible after compaction, a model switch, a crash, or an
interrupted session.

There is no `current.md` and no separate checkpoint file; both were folded into the record
(`knowledge/decisions/views-are-generated-records-are-authoritative.md`) because a view
maintained by hand is a second record with no owner.

## Context and codebase navigation

`graftify`/`graft` builds a local AST knowledge graph so a large codebase can be navigated
without reading it end to end.

- **Use it for:** large or unfamiliar repos, architecture questions, dependency and call
  tracing, "what depends on this?", locating a feature.
- **Don't use it for:** small projects, files you already know, simple edits, config
  changes, obvious bugs. Reading the file directly is faster.
- When indexed: `graft ask "<question>" --source`, `graft map` for orientation.
- `--code-only` is mandatory on client repositories — the default mode sends docs and
  images to an external LLM API.

**Graphify/graft is codebase knowledge, not personal memory.** The two never merge: the
graph is derived data about source code, rebuilt on demand and gitignored; memory is
curated facts about the owner and their decisions.

## Memory and knowledge — detailed schema

Four kinds of context, kept distinct:

| | Answers | Lives | Lifespan |
|---|---|---|---|
| **Memory** | what is true about the owner and their world | `02-personal/<section>/` | years |
| **Knowledge** | what work taught us that saves effort next time | `05-knowledge/<kind>/` | until superseded |
| **Session** | what we are doing right now | `.ai/tasks/current.md`, `sessions/` | one session |
| **Daily** | what happened today | `01-daily/YYYY-MM-DD.md` | one day |

**The test when ambiguous:** *would this still be true if they never wrote another line of
code?* Yes → memory. No → knowledge.

Memory sections: `identity/` · `education/` · `career/` · `projects/` · `goals/` ·
`travel/` · `preferences/` · `interests/`. One canonical home per fact — a fact touching
two sections lives in the one matching its meaning; the other links to it.

Knowledge kinds: `task-results/` · `technical-solutions/` · `decisions/` · `architecture/`
· `research/` · `discoveries/` · `failures/`. Check `knowledge/decisions/` before proposing
something that contradicts a past decision.

Retrieval: `task → identify the domain → read the index → open only what it names`.
`memory/MEMORY.md` and `knowledge/README.md` are the indexes and the only files read by
default. Reading the whole store is a mistake, not thoroughness.

Conflicts: new information contradicting a record is never silently kept alongside it.
Record both versions in `memory/CONFLICTS.md`, ask which is current, then update the
owning file.
