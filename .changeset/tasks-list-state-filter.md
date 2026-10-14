---
"ocean": patch
---

`ocean tasks list <state>` honours the state again when `--project` is not given (it skipped the first argument, so `list active` and `list blocked` returned every task). Frontmatter values lose wrapping quotes, so titles print clean. `scripts/context.sh` leads with the session project's tasks and summarises other projects in one line.
