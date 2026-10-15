---
"ocean": minor
---

Memory and knowledge search is scoped to the session's project. A record's `scope` frontmatter (`global`, or `project:<id>`; missing means global) decides who sees it: a session bound to a project gets global plus that project's records, an unbound session gets global only, and a malformed scope is hidden and listed by `ocean memory reindex`. Applies to `memory.search`/`knowledge.search`, the context ladder, `ocean memory search` (`--project <id>`, `--all`) and the MCP `brain_search`/`brain_neighbors` tools (new `project` and `cwd` arguments). `ocean context` also lists the MEMORY.md files in play. The brain index schema moves to version 2: run `ocean memory reindex` once (a scoped query on an old index says so instead of returning unscoped hits).
