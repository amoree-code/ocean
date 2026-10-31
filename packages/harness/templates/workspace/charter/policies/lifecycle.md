# Policy — the context lifecycle

Load when deciding whether this session should keep going.

```
WORK → PERSIST DURABLE STATE → DETECT BOUNDARY → CHECKPOINT
     → DISCARD LOW-VALUE WORKING CONTEXT → RECONSTRUCT CHEAPLY → CONTINUE
```

**Persistent intelligence without persistent context.** Durable state lives on disk; the
working context is disposable. A long-lived session is not the execution model — it is the
thing measurement found expensive.

## Why

Measured over 53 sessions: per-turn context grew roughly linearly and never fell, no
session ever checkpointed and restarted, and cached re-reads were 57% of weighted spend.
The always-loaded prompt is 8% of where a long session ends up. Session length is the
cost.

## The decision is a command, not a judgement call

```bash
ocean lifecycle                     # continue · checkpoint · compact · fresh · handoff
ocean lifecycle --task <ID>       # against one record
ocean lifecycle --json              # the same verdict, with every signal behind it
```

Deterministic, no model, and it explains itself. Evidence it takes from the records and
from the client's own transcript: task state, verification, whether the record
reconstructs cold, an open handoff, turn count, per-turn growth, large raw tool results.

**No single threshold decides anything.** Two independent cost signals are required
before context is called expensive, and it is never discarded for being large.

## What it cannot know, state explicitly

Nothing on disk knows whether the reasoning in flight still needs this transcript, whether
your next request starts a different workstream, or whether the next step is heavy
disposable investigation. Those are flags, and the default is conservative:

| | |
|---|---|
| `--resolved` | nothing in flight depends on the current context |
| `--complete` | the task's work is done |
| `--transition <ID>` | the next request starts that other task |
| `--exploration` | the next step is heavy disposable investigation |
| `--milestone` · `--verification passed` | durable progress the record does not carry |

Without `--resolved`, FRESH is never recommended. That is deliberate: a keyword rule
guessing at intent would be trusted, and would be wrong.

## The five decisions

| | |
|---|---|
| **CONTINUE** | the same task is in flight and its context is still deciding the work |
| **CHECKPOINT** | durable progress the record does not yet carry — persist it, keep going |
| **COMPACT** | expensive, and the record cannot reconstruct it: compress rather than lose it |
| **FRESH** | the task is finished, or a different one starts, or context is expensive and the record reconstructs cold |
| **HANDOFF** | isolate heavy disposable investigation in a worker so its output never enters this context |

COMPACT is the narrow case, not the habit: it needs expense *and* a record that cannot
rebuild the work. Repeated compaction of the same context is the pattern this replaces.

## Checkpointing

```bash
ocean tasks checkpoint <ID> --note "what landed, evidence, verification state" \
                              --next "the one next action"
```

One writer, one record. It writes nothing when nothing changed, so a boundary that is not
a boundary costs nothing.

Carries: goal · status · milestone · decisions · changed files · evidence · verification
state · blockers · next action · handoff state.

Never: conversation history · raw logs · repeated explanation · superseded reasoning ·
large tool output. Those are why the transcript is expensive; copying them into the record
moves the cost instead of removing it.

`log` is the one-line note. `checkpoint` also moves `## Next action`, which is what the
next cold session actually reads — a record whose next action describes the previous
boundary sends it to the wrong place.

## Restarting is the owner's move

No agent can clear or restart its own Claude Code session. `/clear` and `/effort` are
typed by a person, `--effort` and `--continue` start a new process, and a hook receives the
effort as read-only input. So FRESH prints the boundary and the resume command, and stops
there. Claiming a restart happened would be worse than naming whose move it is.

## Effort

```bash
ocean lifecycle effort --class <small|medium|large>
ocean lifecycle effort --doctor        # what the client is configured to do, against policy
```

Effort follows the declared class — `small: low`, `medium: medium`, `large: high` — and is
overridden **down** to `low` for mechanical work: grep, path lookup, task bookkeeping,
deterministic commands, summaries, simple edits, routine tests, file routing.

Raising it above the class default needs one of the recorded reasons in the model policy:
architecture contract change, security-sensitive decision, large blast radius, ambiguous
root cause, cross-system reasoning, or lower effort having demonstrably failed. A failure
count is not a reason.

The verified effort levers are client-owned: `claude --effort <level>` at launch,
`/effort` typed in a session, and `CLAUDE_CODE_EFFORT_LEVEL` for one process. Ocean does
not maintain a duplicate global `settings.json` effort setting.

Per-task effort via a subagent's `effort:` frontmatter is **confirmed not to work**:
re-probed 2026-09-05 from an ordinary session (no ultracode), a subagent declaring `high`
recorded `medium` — its parent session's level, not the declared one. `model:` in the same
frontmatter *is* honoured. The field has been removed from every agent file; a task's
effort is whatever the session runs at, full stop — set it with `--effort` or
`CLAUDE_CODE_EFFORT_LEVEL` before delegating. Full routing: `ocean policy models`.
