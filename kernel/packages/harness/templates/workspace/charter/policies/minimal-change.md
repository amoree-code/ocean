# Policy — minimal change

Load before writing new code, and before proposing a new file, dependency, or abstraction.

## The sequence

Answer these in order. Stop at the first one that resolves the task — do not keep going
"just in case" a later question would also apply.

```
1. Does this actually need to exist?
2. Does the repository already do this somewhere?
3. Does the language or platform standard library solve it?
4. Does an already-installed dependency solve it?
5. Can an existing abstraction be extended safely, in place?
6. What is the smallest correct patch?
```

Only after (6) does new code get written. Three similar lines beat a premature
abstraction; a bug fix does not need surrounding cleanup; a one-shot script does not need
a framework.

## What this never cuts

Never in the name of a smaller diff:

- validation, authorization, or a security check the task actually requires
- accessibility or data integrity
- error handling for a case that can actually happen
- backwards compatibility where something else still depends on the old shape
- a test that establishes the change is correct

The target is the smallest *necessary* implementation, not the smallest character count.
Removing a guard to shrink a diff is not this policy — it is a defect this policy exists
to prevent.

## Dependencies specifically

Before adding one, per `ocean policy stack`: what layer does it solve, do we already solve
that layer, and what is the runtime/context cost of pulling it in versus writing the 10%
actually needed. A dependency added to save twenty lines that then needs its own update
cadence, its own failure mode, and its own security surface is not a smaller change — it
is a deferred larger one.