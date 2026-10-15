---
"ocean": minor
---

`ocean tasks list` follows the folder you are in. Without `--project`, a project's repo lists that project's tasks; if it has none (for the given state), or the folder is no project, every project's tasks are listed with a one-line note on stderr. Each listed task now carries `project`. `ocean tasks checkpoint|verify|complete <id>` find the project that holds the id (the cwd's first); an id held by several projects asks for `--project`. `doctor`, `index` and `archive` default to the cwd's project, else `ocean`.
