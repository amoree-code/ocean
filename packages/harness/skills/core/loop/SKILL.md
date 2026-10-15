---
name: loop
description: Continue a bounded task across runs with checkpoints, verification, retries, and explicit stop conditions.
version: 1.0.0
category: core
---

# Loop

Use when a task must continue across time or while the owner is unavailable.

Before starting, require a task id, profile, scope, finite budget, maximum iterations, retry policy, and success condition. Each iteration must:

1. Read the task state and latest checkpoint.
2. Do one bounded unit of work.
3. Verify the unit with a real check.
4. Write a concise checkpoint with the next action.
5. Stop on success, budget exhaustion, repeated failure, missing input, authentication, or a consequential action requiring approval.

Never loop blindly over irreversible actions. Preserve the session and task state so a later run resumes from the checkpoint. Report completed work, evidence, remaining work, and the stop reason.
