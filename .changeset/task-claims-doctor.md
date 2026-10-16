---
"ocean": minor
---

`ocean tasks doctor` understands task claims: `claimed_by` + `claimed_at` (+ optional `claimed_paths`) in a live task's frontmatter. A malformed claim or two live claims by different owners on overlapping paths is an error; a claim older than two hours, or one left on a done/cancelled task, is a warning.
