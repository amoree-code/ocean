# Task record schema

The structural contract for `~/ocean/04-projects/<project>/tasks/<ID>/task.md`. One
file per durable task. **The project owns its work**, and that record is the
authoritative one. `task.md` is the **only** mandatory file in a task; everything
else is an artifact created on demand (see §4).

There is no global task namespace. `~/ocean/tasks/` held redirect pointers for one
release and has been deleted; an id resolves directly at `04-projects/<project>/tasks/<ID>/`
(`ocean-paths` was the resolver for this in an earlier CLI generation — it was
consolidated away and is not a real command anymore). If two projects ever claim the
same id, that is a conflict to resolve by hand, not to merge.

`ocean memory doctor` does not validate this — it owns the memory store. This schema is
the contract; the rule that enforces it in practice is
`charter/policies/task.md` (`ocean policy task`).

**Workspace paths are the live layout, not a moving target.** The relocation this
section used to describe (several private roots migrated one reversible slice at a
time via an `ocean-paths` resolver) is finished; that tool was consolidated away and
is not a real command anymore. There is no `work` root — tasks and context live
directly under each project, so `04-projects/<project>/tasks/<ID>/` is the lookup for a
durable record. If a root is ever found present in two different layouts at once,
that is a conflict to resolve by hand — never merge, copy, or pick a side
automatically.

---

## 1. Identity

```
<SCOPE>-<NNN>
```

`SCOPE` is short, uppercase, and stable: a project key from
`04-projects/registry.md` (`RCCM`, `RIYADA`, `HARMONY`), `OCEAN` for work on this
system, or `OPS` for machine/workspace work with no project. `NNN` is a zero-padded
counter within the scope, never reused.

The ID is the task's name everywhere — index, session records, commit messages, chat.
It never changes, including after the task is archived.

## 2. Frontmatter

```yaml
---
id: OCEAN-002 # required · matches the directory name
title: <one line> # required · what the task is, not how
state: active # required · see §3
project: ocean # required · registry name, or `-` for none
opened: 2026-08-31 # required · YYYY-MM-DD
updated: 2026-08-31 # required · YYYY-MM-DD, bumped whenever the file changes
artifacts: [decisions.md] # required · [] when task.md is the whole record

class: medium # optional · small | medium | large — how much reasoning the work needs
expected_context: small # optional · small | medium | large — how much context it should take
---
```

`class` and `expected_context` are **durable classifications of the task**, and the only
routing-relevant fields a task carries. `class` is what the work is: `small` is a change
whose shape is already known, `medium` is ordinary implementation and debugging, `large` is
architecture, security, an ambiguous requirement or a migration. `expected_context` is a
prediction, used to notice when a task's real context runs far past what its shape implied.

Neither is a limit, and neither is enforced. **Runtime decisions do not belong here** — the
model and effort actually used, which memory and knowledge were retrieved, which
capabilities were exposed, whether a graph was consulted, and what the session did at the
end are all properties of one run rather than of the task, and are recorded in runtime
receipts. A task that accumulated them would become a log of every attempt at it.

`claimed_by`, `claimed_at` and `claimed_paths` are **optional and transient**: they say a
session is working on the task right now (T-270). `claimed_at` is an ISO-8601 UTC timestamp;
`claimed_paths` is an inline list (`[kernel, docs]`). A claim goes stale after 2 hours and is
removed by `ocean tasks release` — it is not part of the task's lasting description. Rules
and commands: `ocean policy task`, "Claims".

### Verification fields (T-320)

```yaml
verify: # the checks · inline `verify: pnpm test, ocean tasks doctor`, or a block list:
  - AC-1: pnpm build && pnpm test # `AC-n:` names the Definition-of-done item it proves
  - AC-2: ocean tasks doctor
review: agent # optional · agent | none — owner opt-in to the model review
verified: yes # written by `ocean tasks verify` · yes | no | partial | unknown
verified_at: 2026-11-21T09:00:00.000Z # written · ISO-8601 UTC
evidence: [AC-1:event:812, AC-2:event:813] # written · one event id per check
assumed: [independent review not run] # what was not checked; verify appends, never removes
base_commit: 3f2a… # written by the first `ocean tasks claim`, never changed after
```

`verify:` is read from the frontmatter only (never a body line); without it, the fenced block
in `## Verification`, where a line may also start with `AC-n:`. Only allowlisted commands run
— a check never publishes, signs in or installs globally.

`ocean tasks verify <ID>` runs the checks with no model involved, then decides:

| `verified` | when                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------ |
| `yes`      | every check passed, and every `AC-n` in the Definition of done has a passing check          |
| `partial`  | every check passed, but an `AC-n` has no check of its own, or an opted-in review could not run |
| `no`       | a check failed, nothing runnable was declared, the claimed paths never changed, or the review failed |
| `unknown`  | never verified                                                                             |

Each check becomes a `task_verify` evidence event in a `tasks-verify` session linked to the
task; the same events are copied to every session already linked to it, whose
`verification_status` becomes `proven` (yes) or `not_proven`. Lesson learning counts only
`task_verify` and `test` evidence — a provider exiting 0 proves nothing.

**Base commit.** While the task is claimed with `claimed_paths`, verify fails when nothing
under those paths changed since `base_commit` (committed, staged, unstaged or untracked).

**Lanes.** `class: low | medium` (or `small`) is verify only. `class: high | large` asks for
verify + review, but the review runs only when the task sets `review: agent` (the owner opts in
per task — no subagent runs on its own); without it the verdict stands and `assumed:` records
that no review ran. The review runs after the deterministic checks and never when they failed:
the cheapest model, read-only, checking only that every claimed item points to evidence, ending
with one line, `pass` or `fail — <reason>`.

`artifacts` lists what actually exists beside `task.md`, and nothing more. It is a
manifest, not a plan: a name appears here the moment the file is written and never
before. An empty list is the normal, healthy value.

`project: -` is legitimate. A task does not need a project.

## 3. States

```
todo ──▶ active ──▶ in-qa ──▶ done ──▶ (archive/)
          │  ▲  ▲       │  PR open, waiting on test or review
          │  │  └───────┘  a fix is needed
          │  └──── paused ──┐  deliberately set aside; resumable by choice
          ├──────▶ blocked ─┤  cannot proceed; waiting on something external
          │        ▲        │
          │        └────────┘
          └──────▶ cancelled ──▶ (archive/)
```

| State       | Means                                                       | Leaves when                             |
| ----------- | ----------------------------------------------------------- | --------------------------------------- |
| `todo`      | promoted to a durable task, not started                     | work begins → `active`                  |
| `active`    | being worked now                                            | paused, blocked, finished, or abandoned |
| `in-qa`     | built, PR open, waiting on test or review                   | PR merged → `done`; fix needed → `active` |
| `paused`    | set aside by choice, resumable                              | picked up again → `active`              |
| `blocked`   | cannot proceed; the blocker is named in the body            | blocker clears → `active`               |
| `done`      | finished **and** verified — the verification ran and passed | archived                                |
| `cancelled` | abandoned; the reason is recorded in the body               | archived                                |

**There is no `current` task and no stored pointer to one.** The active set is derived:
every task whose `state: active`. More than one may be active at a time — that is the
normal case, not an error. Which one a given moment concerns is resolved the same way
the active _project_ is (cwd against the registry) or by asking. Nothing mutable is
stored to answer it.

`done` is a state; archiving is a location. A task stays under `tasks/` while it is
still live context and moves to `archive/<ID>/` when it is not.

## 4. Body

Recovery fields first — they are what a cold session reads. This is the checkpoint
mechanism: for most tasks `task.md` **is** the checkpoint, and no separate
`checkpoint.md` exists.

```markdown
## Objective

<what done looks like from outside, one or two lines>

## Definition of done

<the observable condition that proves it works>

## Next action

<the single next thing to do — concrete enough to start cold>

## Verification

<the command that proves the work, and its last actual result>

## Blockers

<none, or the specific thing and who or what can clear it>

## Log

- 2026-08-31 — <what landed, with the file it touched>
```

Optional sections, added only when there is something to put in them: `## Scope`
(explicit non-goals), `## Sessions` (only when the session records are hard to find).

`## Log` is append-only and dated. It replaces the old `completed:` / `remaining:` /
`last_successful_action:` fields: what landed is in the log, what remains is the next
action, and the last successful action is the last log line.

## 5. Artifacts

An artifact is any file in the task directory other than `task.md`. It exists only
because something needed to persist that `task.md` could not hold.

**No artifact is scaffolded. Ever.** There is no fixed set, no template directory, and
no empty placeholder. A task directory containing only `task.md` is complete.

Two tests decide, in order:

1. **Is it needed?** Would a future session — or the same session after compaction — be
   materially worse off without this file? If the answer is "it might be nice", the
   answer is no.
2. **Does it belong to the task, or to the world?** Task-specific → the task directory.
   Reusable beyond this task → `05-knowledge/<decisions|lessons>/` instead, and the task links
   to it. Durable fact about the user → `02-personal/`.

Test 2 is the one that keeps task directories small. A finding worth keeping is almost
always knowledge, not a task artifact.

Naming is descriptive and lowercase (`research.md`, `decisions.md`, `checkpoint.md`,
`api-notes.md`). The common shapes and their triggers are in
`charter/policies/task.md` § Task artifacts; that list is a guide to recognising a trigger, never a
checklist to satisfy.

## 6. Completion

When a task reaches `done`:

1. `ocean tasks verify <ID>` has run, and the task carries `verified: yes` (or `partial`)
   with its `evidence` ids — `ocean tasks doctor` fails a `done` task without them.
2. Each artifact is resolved once — promoted to `05-knowledge/<decisions|lessons>/` if reusable,
   left with the task if not. Nothing is copied to both places.
3. `state: done`, `updated:` bumped, the index line updated.
4. The task moves to `archive/<ID>/` when it stops being live context.

Steps 2–4 are bookkeeping: they belong to `task-scribe` and `memory-curator`, never to a
reasoning model.
