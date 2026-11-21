---
"@amoree-code/ocean": minor
---

feat(tasks): new task state `in-qa`, for work that is built with its PR open and waiting on test or review. The validator accepts it, the projects overview and day plan count it as open, and `ocean context` / `context.sh` list it beside active and blocked. It moves to `done` once the PR merges and verification passed, or back to `active` when a fix is needed. The task policy and contract document it.
