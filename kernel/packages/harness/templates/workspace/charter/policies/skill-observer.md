---
triggers: ["session end", "skill signal", "improve skill", "نهايه الجلسه"]
digest: "At a checkpoint or session end only: note a skill signal in one line; never rewrite a skill file automatically."
---

# Policy — skill observation

Load at a checkpoint, a handoff, or session end (`ocean policy lifecycle`) — never
continuously during a task.

## What counts as a signal

Only these, and only when they actually happened this session:

```
the owner corrected an approach
the same workaround was applied more than once
a skill or capability was invoked and failed
a needed capability did not exist
routing picked the wrong tool, model, or skill for the task
a skill activated when the task did not need it
```

No signal this session ⇒ write nothing. A quiet session produces zero observation lines,
not a summary saying so.

## Where it goes

There is no separate observation log — that would be a second lifecycle subsystem next to
the one that already exists. A signal is recorded exactly like any other durable fact from
the session:

- a corrected approach or a validated judgment call → `ocean policy feedback` territory,
  written to `02-personal/` per that policy's rules
- a missing capability, a bad routing outcome, or a repeated workaround → one line in the
  task's own checkpoint note (`ocean tasks checkpoint <ID> --note "..."`), or the
  session record if there is no task

## Profile routing — at session end only

Run `ocean profiles doctor`. It reads the profile selection log and prints each repeated
routing miss with a `suggest:` line: a trigger to add to a profile, or a profile to bind to
a project. Offer each suggestion to the owner in one line and apply it only on his explicit
yes, as an ordinary edit of that profile or `project.json`. No findings ⇒ say nothing.

## What this never does

- **Never rewrites a skill file automatically.** An observation is a candidate for a human
  review, not an edit. Changing a skill, a policy, or a rule file happens through the same
  explicit, reviewed path as any other change to governance — never as a side effect of
  "noticing" something.
- **Never runs as an always-on transcript watcher.** Event-driven only: check at a
  boundary that already exists (checkpoint, handoff, session end), not on every turn.
- **Never generates observation noise.** If the signal cannot be stated in one line with
  the concrete evidence (what was corrected, what failed, what was missing), it is not
  ready to record yet — keep working, revisit at the next boundary.