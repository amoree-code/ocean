# Policy — the task loop

Load when starting, checkpointing or completing a unit of work.

```
UNDERSTAND → PLAN → EXECUTE → OBSERVE → TEST → VERIFY
   → error? → DIAGNOSE → FIX → RETEST (loop)
   → FINAL VERIFICATION → COMPLETE
```

**Changing the code is not completion.** Completion is the verification passing. Continue
until the authorized task is actually complete; if part of the scope is genuinely blocked,
finish everything else and say plainly what was left and why.

Plan first for anything touching multiple files or making an architectural decision. Skip
planning for a one-line fix.

## Cold start

```bash
ocean context            # project, live tasks, next actions, git state
ocean context <ID>       # one task in full
```

That packet is derived from the records every time it runs, so it cannot be stale. Read a
file only when the packet says the work needs it. Do not read a project's `state.md`,
`roadmap.md` or `charter.md` to find out what to do next — none of them knows.

"What tasks do I have?", in any wording → `ocean tasks list` run **from the owner's working folder**
(MCP: `ocean_tasks_list` with `cwd`). It returns that folder's project's tasks; when the
project has none or the folder is no project, every project's, labelled. Never answer it by
listing `04-projects/` by hand.

## Every task is a task

The moment real work starts on something the owner asked for — in any project, whether or not they
says "task" — it becomes a task directory: `04-projects/<project>/tasks/<ID>/`. Size or
expected duration is not the test anymore; **a task was given** is the test.
`04-projects/backlog.md` is for intentions not yet started, not for work in progress.

**The task is the only place its status is declared.** Every other view of it is
generated; `ocean tasks index --write` regenerates the board and `ocean tasks doctor`
fails when a view has drifted. Never hand-edit a generated table, and never write a
task's status into project state, a daily log or a session record as if it were
authoritative there.

States: `todo` · `active` · `paused` · `blocked` · `done` · `cancelled`. Several being
`active` is normal. There is no current task and no stored pointer to one — the active
set is derived from the records. A bare id resolves directly at
`04-projects/<project>/tasks/<ID>/` (`ocean-paths` was a resolver in an earlier CLI
generation and was consolidated away — it is not a real command anymore); if two
projects ever claim the same id, that is a conflict to resolve by hand, not to merge.

Contract: `internal/schemas/task.md`.

## Claims — more than one session at once

Sessions share one disk and know nothing of each other, so two on the same task overwrite
each other silently. Before editing, **claim the task**; the claim is advisory and lives in
the task's own frontmatter (`claimed_by`, `claimed_at`, optional `claimed_paths`).

```bash
ocean tasks claim <ID> --by <your-session-name> [--paths kernel,packages/harness/src]
ocean tasks release <ID> --by <your-session-name>      # when you stop, hand off or finish
```

- **Refused** (exit 1, holder named) → another session holds it. Do not take the task, do not
  `--force`. Work on another task, or tell the owner and wait. A claim expires after 2 h, so a
  dead session never blocks forever; re-claim to refresh while you keep working.
- **`--paths`** is how a file-level claim is made: use the directories you will edit, and
  `kernel` when you will switch branches or commit in the kernel checkout (it shares one HEAD).
  Overlapping paths held by another session on another task are refused too.
- **Shared single-file stores** (`MEMORY.md`, an index): re-read immediately before writing
  and append a line rather than rewriting the file, so a concurrent write is not lost.
- `ocean tasks doctor` errors on a malformed claim or two live claims on overlapping paths,
  and warns on a stale one. Nothing blocks a raw file edit — the claim only works if every
  client runs the step.

(`claim`/`release` ship with T-270's kernel PRs; until they are merged and installed, record
the same three fields by hand.)

## Keeping a task cheap

`task.md` is what a cold session reads, so everything in it is paid for on every such read.

- **`## Next action` is one action.** Not a status report, not three alternatives.
- **`## Log` keeps the recent entries.** Older ones move to `log.md` beside it.
- **`## Verification` is the command and its last real result**, not a transcript.
- History, designs and investigations are artifacts beside `task.md`, named in
  `artifacts:`, never inlined into it.

`ocean tasks doctor` warns when a record has drifted back into being a transcript.

## Task artifacts — created on demand, never scaffolded

`task.md` is the only mandatory file. Two tests, in order:

1. **Is it needed?** Would a future session be materially worse off without it?
   "It might be nice" means no.
2. **Task, or world?** Reusable beyond this task → `05-knowledge/<kind>/` instead,
   and the task links to it.

| Artifact | Written when |
|---|---|
| `research.md` | something external was investigated and the answer will be reused |
| `decisions.md` | a choice was made among real alternatives and the rejected ones still matter |
| `log.md` | the log outgrew the hot path |
| `notes.md` | raw working material too large for `task.md` and not yet shaped |

Most tasks produce `task.md` and nothing else. That is the correct outcome, not a gap.

## On completion — automatic, not on request

1. **Final verification** — run it, and report the real output.
2. **Lifecycle reading** — `ocean lifecycle --task <ID> --complete --verification passed|failed`.
   This is the boundary hook: a task finishing is exactly the `TASK_COMPLETED` trigger, and
   this is the one place it fires, deterministically, on every completion. Act on the
   decision before moving on: `CHECKPOINT` → covered by step 4 below; `FRESH` → checkpoint
   first, then tell the owner a fresh session is recommended and how to resume; `HANDOFF` →
   run the `session-handoff` skill instead of continuing in this context. `CONTINUE` needs
   nothing further here.
3. **Summary** — what changed, where, what proves it.
4. **`memory-curator`** — classify what the task produced and route each item once. Most
   tasks produce nothing worth keeping; that is correct. See `memory.md` and `knowledge.md`.
5. **`task-scribe`** — task state, the project index, the daily log, the backlog line.
6. Sync only if canonical rules or skills changed.

Steps 4-6 are bookkeeping: delegate them, never run them on a strong model. Step 2 is a
single deterministic CLI call — no model reasoning, so it costs nothing to run on every
completion.

**Task completion is not session end.** Completion is where work state is saved, and it is
automatic. `/session-end` is optional cleanup, never the mechanism.

## Session records

`internal/sessions/` is not a second transcript store. A record holds the task, the
decisions, what was completed, important evidence, unresolved issues, the next action, and
references to the authoritative artifacts. Never a replay of the conversation.
