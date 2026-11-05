---
"@ocean/core": patch
"ocean": patch
---

`paths`, `fs-utils`, project resolution and task lookup move into `@ocean/core/shared`. The `ocean` CLI registers its package root with core at startup, so `engineRoot()`, `oceanRoot()` and `repoRoot()` resolve exactly as before.
