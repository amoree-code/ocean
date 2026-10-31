# Policies — loaded when they apply, not before

`../rules/core.md` is the bootstrap: identity, the hard boundaries, and a routing table.
It is rendered into every AI client's system prompt, so every byte in it is paid for on
every request of every session, whether or not the request has anything to do with it.

These modules hold the rest. Each is read **when the work is of that kind**, through:

```bash
ocean policy <name>          # print one module
ocean policy list            # what exists, and when each applies
```

| Module | Load it when |
|---|---|
| `task.md` | starting, checkpointing or completing a unit of work |
| `context.md` | deciding what to read, how much, and when to stop |
| `memory.md` | recording or retrieving a durable fact about the owner |
| `knowledge.md` | recording or retrieving what past work taught |
| `git.md` | anything beyond reading git state |
| `models.md` | choosing a model, an effort level, or delegating |
| `concise-output.md` | producing any response |
| `minimal-change.md` | writing new code, or adding a file/dependency |
| `skill-observer.md` | a checkpoint, a handoff, or session end |
| `verification.md` | proving a change works |
| `response.md` | formatting a substantial reply |
| `graph.md` | navigating an unfamiliar or large tree |
| `stack.md` | choosing libraries or scaffolding a project |

A module states what must be true. It never states how one client implements it — that is
the adapter's, and lives in the public repo.