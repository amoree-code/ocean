# Application layer

Orchestration entry points (`runAgent`/`resumeAgent`, hooks, session and skill lifecycle).
Depends on `domain/` and `infrastructure/`, never the other way around. Never write private
user data — `personal/`, `projects/`, or the other workspace directories described in the
root [AGENTS.md](../../../../AGENTS.md) — into anything under the engine package itself.
