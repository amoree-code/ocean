---
"ocean": minor
---

`ocean hook session-start --client codex|hermes` emits the Ocean bootstrap in each client's own hook format, so those clients can reach Ocean through their native hooks instead of a same-name shim. Codex gets Claude Code's `hookSpecificOutput`; Hermes (registered as `pre_llm_call`) gets `{"context": ...}` on the first turn only. `--client=<id>` is accepted, a non-object JSON payload is treated as empty, and an empty `cwd` falls back to the process cwd.
