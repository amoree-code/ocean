---
"ocean": minor
---

Headless runs now send a lean prompt: a skill index with SKILL.md paths instead of full skill bodies, a compact `key: value` profile contract, a profile facts digest capped at 2 KB with a pointer to the full set, and context references (paths and why) instead of file bodies, with owner-reviewed promoted skills kept inline up to 4 KB. Every reference stays inside the profile's `allowedPaths`, and skill folders, the facts store (when the digest is partial) and reference directories inside `allowedPaths` that lie outside the run cwd are granted to Claude (`--add-dir`) and Gemini (`--include-directories`), on the first turn and again on a resumed Claude turn. The `context_cost` event gains a per-section byte breakdown that sums to the total, and the new read-only `ocean context cost [--json] [--budget <bytes>] [--project <dir>]` reports each client's always-on context bytes (rules files, memory index, skill frontmatter) using `~/` paths only.
