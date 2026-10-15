---
"ocean": minor
---

A project's `project.json` can carry `rules` (hard constraints, up to 10 single lines) and `verify` (up to 5 commands). The session-start hook adds `rules=N` to the bootstrap and injects the rules as a bounded `Project rules (<id>):` block, the exact-record context read and headless prompts carry them first, and `ocean context` prints them. `ocean tasks verify` falls back to the project's `verify` (same command allowlist, run in the project's first path) when a task declares no runnable command; the outcome reports its `source`.
