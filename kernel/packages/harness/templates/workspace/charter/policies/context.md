# Policy — context admission

Load when deciding what to read, how much of it, and when to stop.

**Storage is not context.** A fact existing in memory, knowledge, project state, a task,
a session record or the filesystem does not mean it should enter the model's context. It
stays external until the task needs it.

**Conversation is working memory, not durable memory.** Decisions and state are distilled
into the task; after that the conversation is expendable.

## Admission

Before reading something, the question is not "is it available?" but "why does the model
need this now?" Five answers:

| | |
|---|---|
| **ADMIT** | it decides something in this task |
| **DEFER** | it may matter later; name it, do not read it |
| **SUMMARIZE** | it decides something, but only a small part of it does |
| **ISOLATE** | reading it would pollute this context; send it to a worker |
| **REJECT** | it is not relevant, however available it is |

Deterministic first: the project comes from the working directory, the task from the
records, the policy from the kind of work. Reason about admission only where those do not
already answer it.

## Progressive loading

```
search → identify → read the relevant range → act, or expand on evidence
```

Not: read the whole file, the whole directory, the whole repository, all of memory. Expand
because evidence demands it, never in case it helps.

## Sufficient context — the stop condition

**"Do we already have enough evidence to execute correctly?"** If yes, stop retrieving. Do
not keep reading because more is available. If no, name what is missing and get exactly
that.

Under-reading is a correctness failure and outranks every budget here. When confidence is
low, expand. The target is *minimum sufficient* context, never minimum context.

## Value per token

Prefer small and highly relevant over large and possibly useful. Weigh relevance,
necessity, freshness, authority and scope against what it costs to read. Reject weak,
expensive context.

## Relevance decays

Current error and the file being changed are HOT. Subsystem shape is WARM. A resolved
command's output is DEAD. An unrelated earlier task is COLD. Relevance decays unless
renewed by current evidence — which is what makes a checkpoint and a fresh context cheap
rather than lossy.

## Tool output

Raw output does not enter context by default: shell, tests, logs, diffs, API and MCP
responses, browser output, database results, large reads.

```bash
ocean observe -- <command>          # keeps the raw, returns what decides
ocean observe show <id> --grep RE   # retrieve any slice, later
```

Return the exit status, the failing names, the relevant error lines and the paths — not
twenty thousand lines of passing tests. Do not wrap a command whose output is already
small: the wrapper would cost more than it saves.

Re-reading a file that has not changed buys nothing. `ocean observe` reports an identical
re-run in one line instead of re-admitting the text.

## Isolate heavy, disposable reads

Send to a worker when the work would pour a large amount of throwaway context into this
one: broad repository exploration, large logs and test output, documentation research,
multi-file investigation, an independent workstream.

Do not spawn one for a single grep, one small file or a trivial edit — a worker re-reads
its own floor, so it costs more than it saves there. The question is whether the parent
would otherwise be polluted, not whether the output is long.

## What comes back

A worker returns a packet, never a transcript: goal · findings · evidence · confidence ·
relevant paths · constraints · recommended action · unresolved issues · verification
state. The same shape as a handoff record, for the same reason.
