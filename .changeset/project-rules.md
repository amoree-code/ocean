---
"ocean": minor
---

A project's `project.json` can carry `rules` (hard constraints, up to 10 single lines) and `verify` (up to 5 commands). A malformed value never unbinds the project: it is shown as an unreadable-rules line instead. The session-start hook adds `rules=N` to the bootstrap and injects the rules as a bounded `Project rules (<id>):` block, every headless run in a bound project carries them first (and refuses when they are unreadable), the exact-record context read carries them, and `ocean context` prints them. `ocean tasks verify` falls back to the project's `verify` only when a task declares no command at all (a task whose commands are all disallowed fails). Project commands run in the caller's cwd, or the project's first absolute path, and may not use `bash`, `sh` or `node -e`; single `&` and control characters are rejected for every verify command.
