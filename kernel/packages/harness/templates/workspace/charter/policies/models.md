# Policy — model and effort routing

Load when choosing a model, choosing an effort level, or delegating.

Routing happens **by delegation to model-pinned agents**, never by a gateway and never by
asking the owner to switch. Recorded: `knowledge/decisions/no-model-routing-gateway.md`.

## Tiers

| Tier | What runs it | For |
|---|---|---|
| **0** | no model at all | path resolution, task lookup, project detection, parsing config, reading the registry, listing changed files, filtering a log, counting tokens |
| **1** | cheapest capable model | classification, small summaries, log reduction, retrieval ranking, bookkeeping |
| **2** | the normal model | implementation, UI, refactoring, ordinary debugging, tests, docs |
| **3** | the strong reasoning model | architecture, security reasoning, deeply ambiguous problems, difficult cross-system debugging, large migrations |

**Tier 0 first, always.** Before routing anything to a model, ask whether reliable
deterministic code already answers it. `ocean context`, `ocean tasks`, `ocean observe`
and `git` are Tier 0 and answer most of what a session needs to know. (`ocean-paths` was
a Tier-0 tool in an earlier CLI generation; it was consolidated away and is not a real
command anymore — resolve a task path directly at `04-projects/<project>/tasks/<ID>/`.)

A strong model should make difficult decisions, not spend turns on grep, file reading and
bookkeeping. **Administrative work never runs on the task's model**: memory and knowledge
routing → `memory-curator`; summaries, checkpoints, logs, registry updates → `task-scribe`.

## Effort follows the task's class

The task declares `class`. Match effort to it: `small` → low, `medium` → normal,
`large` → high. "Always think deeply" and "always be exhaustive" are not policies; they
are a standing bill.

## Escalation is evidence, not arithmetic

Escalate to Tier 3 when there is a **reason**, and record it:

- the failure is a genuine reasoning difficulty, not a typo or a wrong path;
- the cause is in a different place from the symptom;
- a race, a heisenbug, or state that changes under observation;
- the blast radius is large, or the change is architecturally load-bearing;
- two honest attempts failed **and the hypotheses ruled out are written down**.

Two failures alone are not a reason. Two failures whose evidence points somewhere the
current tier cannot reach is. Say one line — *"Two attempts failed; handing the root-cause
hunt to `debugger`, ruled out: X, Y."* — then do it. A bare counter is a conservative
floor, not the rule: never escalate past three failures without a written reason.

## Delegation carries the task forward

It never restarts it. Hand the agent the objective, what is already done, what was already
ruled out, and where the record is. Never re-derive established work.

```
simple:   TASK → tier 2 → execute → verify → done
complex:  TASK → architect (tier 3) → plan → tier 2 implements → test
                → debugger (tier 3) only if verification is genuinely hard
```
