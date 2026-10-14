---
"ocean": patch
---

`ocean tasks list --project <id>` (and the MCP `project` argument) fail with "No project <id>" for an id with no project folder, instead of listing nothing. `ocean tasks list --pretty` prints an aligned PROJECT/ID/STATE/TITLE table.
