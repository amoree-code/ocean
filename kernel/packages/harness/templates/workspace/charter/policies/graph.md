# Policy — Graph Brain

Load when navigating an unfamiliar or large tree. Graph Brain is an **accelerator, not a
first step.**

## Decide in this order

1. **Can the cheap route answer it?** `ocean context`, the project index, the registry,
   `grep`, a targeted read. Usually yes — then stop.
2. **Is a fresh graph already built?** Query it.
3. **Would building one materially help this task?** Only then build it.

A one-line fix, a config change, an obvious bug or a file you already know needs no graph.
Reading the file is faster.

## Two graphs, never merged

| Ask | Graph | Root |
|---|---|---|
| where is X recorded · what did we decide · what is still open | global brain | `~/ocean` |
| how does this code work · what calls it · what breaks if I change it | project graph | the project repo |
| what is true about the owner | neither — `memory/MEMORY.md` | |

```bash
graphify query "<question>"   graphify path "<A>" "<B>"   graphify explain "<X>"
cd <root> && graphify update .        # --force after deletions
```

- **`--code-only` is mandatory** on every client and public code repository.
- **Never pass `--no-gitignore`** — it drags worktrees and `runtime/` into the graph.
- **Never merge the two graphs, and never `--global`.** The private graph carries personal
  memory and is `publishable: false`.
- **Never set `GEMINI_API_KEY` / `GOOGLE_API_KEY`.** With a key set, extraction routes to
  Google, which on the private root would ship memory off the machine. There is no key
  today; keep it that way.

## What a graph is and is not

**Graph explains. Files decide. Tests prove.** It tells you where to look; open the real
file before changing anything, and prove the change with tests. Never quote a graph node as
evidence — it is a summary from extraction time and goes stale the moment a file changes.

Derived, never authoritative: rebuilt on demand, gitignored, never edited, never committed,
never published. It may suggest a relevant skill, capability or record, but the real record
must still be read and the task's approval gates still apply.

Detail: `05-knowledge/architecture/ocean-graph-brain.md`.
