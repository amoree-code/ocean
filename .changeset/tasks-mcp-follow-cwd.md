---
"ocean": minor
---

The `ocean_tasks_list` MCP tool and the `ocean://tasks` resource follow the folder too: they take an optional `cwd` (default: the server's folder) and `project`, and return `{ scope, project, tasks, note }` — the folder's project's tasks, or every project's when it has none.
