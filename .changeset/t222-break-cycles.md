---
"ocean": patch
---

Break the import cycles that blocked the package split: project resolution and task lookup move to `src/shared/`, session closeout moves to `sessions/`, and the Ocean MCP server receives its ports from the CLI instead of importing the composition root.
